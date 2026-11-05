import { join } from "node:path";
import { claudeAdapter } from "./engine/agents/claude";
import { codexAdapter } from "./engine/agents/codex";
import { geminiAdapter } from "./engine/agents/gemini";
import { config } from "./engine/config";
import { openDb } from "./engine/db";
import { trimLog } from "./engine/logfile";
import { keepAwake, powerSource } from "./engine/power";
import { createRunner, recoverOnBoot } from "./engine/runner";
import { onApprovalResolved } from "./engine/approvals";
import { createMarketsHooks } from "./engine/markets/agent";
import { evaluateQuotes } from "./engine/markets/alerts";
import { marketNow } from "./engine/markets/calendar";
import { createMarketData } from "./engine/markets/data";
import { createFeed } from "./engine/markets/feed";
import { eodJob } from "./engine/markets/eod";
import { newsJob } from "./engine/markets/events";
import { fundsJob } from "./engine/markets/funds/refresh";
import { fxJob } from "./engine/markets/fx";
import { createJobs } from "./engine/markets/jobs";
import { createKeychain } from "./engine/markets/keychain";
import { metaJob } from "./engine/markets/meta";
import { digestJob } from "./engine/markets/research";
import { anyStrategyActive, enqueueDueStrategies, handleStrategyDecision } from "./engine/markets/strategies";
import { getSetting } from "./engine/settings";
import { setupSpace } from "./engine/setup";
import { startServer } from "./server/server";

// Keep launchd's log from growing forever; must run before anything logs.
trimLog(join(config().home, "engine.log"), 1024 * 1024);

const url = `http://${config().host}:${config().port}`;
const db = openDb();
const adapters = { claude: claudeAdapter(), codex: codexAdapter(), gemini: geminiAdapter() };
// Market time: the real clock, or the demo clock ATRIUM_MARKET_NOW shifts while the provider is Demo.
const marketClock = () => marketNow(getSetting(db, "markets.provider") ?? "alpaca");
const keychain = createKeychain();
const data = createMarketData({ db, keychain, now: marketClock });
// Daily and weekly market jobs, run from the feed's own timer.
const jobs = createJobs(
  db,
  [
    fxJob(db, { now: marketClock }),
    eodJob(db, { data, tiingo: () => data.tiingo?.() ?? null, now: marketClock }),
    fundsJob(db, { now: marketClock }),
    metaJob(db, { data, now: marketClock }),
    newsJob(db, { data, now: marketClock }),
    digestJob(db),
  ],
  marketClock,
);
const runner = createRunner({ db, adapters, power: powerSource, keepAwake, markets: createMarketsHooks(db, { data, now: marketClock }) });
const feed = createFeed({
  db,
  data,
  now: marketClock,
  onQuotes: (quotes) => evaluateQuotes(db, quotes, marketClock()),
  strategyActive: () => anyStrategyActive(db),
  onTick: (now) => enqueueDueStrategies(db, now, () => runner.kick()),
  jobs,
});
onApprovalResolved((a, decision) => handleStrategyDecision(db, a, decision));

// Bind before recovery: the port is the lock, so a second engine leaves the first one's tasks alone.
let server: ReturnType<typeof startServer>;
try {
  server = startServer({
    db,
    runner,
    setup: (text) => setupSpace(db, claudeAdapter(), text),
    onViewers: (n) => void feed.setViewers(n),
    markets: { data, feed, keychain, kick: () => runner.kick(), now: marketClock, jobs },
  });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
  console.error(`Atrium is already running at ${url}`);
  process.exit(1);
}

await recoverOnBoot(db);
runner.start();
void feed.start();
console.log(`Atrium running at ${url}`);

let stopping = false;
const shutdown = async () => {
  // launchd and Ctrl-C can both signal; a second stop would race the first.
  if (stopping) return;
  stopping = true;
  console.log("Atrium stopping");
  let code = 0;
  try {
    feed.stop();
    await runner.stop();
    keepAwake.stop();
    // Open dashboard sockets would otherwise keep shutdown waiting forever.
    await server.stop(true);
  } catch (e) {
    // Exit anyway: a half-stopped engine still holding the port is worse than an unclean stop.
    console.error("Shutdown error:", e);
    code = 1;
  }
  process.exit(code);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
