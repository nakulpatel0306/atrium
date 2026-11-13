import { join } from "node:path";
import { claudeAdapter } from "./engine/agents/claude";
import { codexAdapter } from "./engine/agents/codex";
import { geminiAdapter } from "./engine/agents/gemini";
import { config } from "./engine/config";
import { installCrashGuard, noteRestart } from "./engine/crash-guard";
import { openDb } from "./engine/db";
import { logActivity } from "./engine/events";
import { migrateSpaceFolders, tildePath } from "./engine/folders";
import { stampConsole, trimLog } from "./engine/logfile";
import { keepAwake, powerSource } from "./engine/power";
import { createRunner, recoverOnBoot } from "./engine/runner";
import { onApprovalResolved } from "./engine/approvals";
import { createMarketsHooks } from "./engine/markets/agent";
import { evaluateQuotes } from "./engine/markets/alerts";
import { marketNow } from "./engine/markets/calendar";
import { createCatchUp } from "./engine/markets/catchup";
import { createMarketData } from "./engine/markets/data";
import { createFeed } from "./engine/markets/feed";
import { eodJob } from "./engine/markets/eod";
import { newsJob } from "./engine/markets/events";
import { fundsJob } from "./engine/markets/funds/refresh";
import { fxJob } from "./engine/markets/fx";
import { createJobs } from "./engine/markets/jobs";
import { createKeychain } from "./engine/markets/keychain";
import { metaJob } from "./engine/markets/meta";
import { redact } from "./engine/markets/redact";
import { digestJob } from "./engine/markets/research";
import { anyStrategyActive, enqueueDueStrategies, handleStrategyDecision } from "./engine/markets/strategies";
import { createRepos } from "./engine/repos";
import { recoverRemovals } from "./engine/repos/cleanup";
import { finishPendingDeletes } from "./engine/delete-files";
import { recoverRepoActions } from "./engine/repos/create";
import { createMessaging } from "./engine/messaging";
import { createMail } from "./engine/mail";
import { createInboxHooks } from "./engine/mail/agent";
import { recoverMailActions } from "./engine/mail/send";
import { moneyDaily } from "./engine/money/reminder";
import { recoverMessageActions } from "./engine/messaging/send";
import { getSetting } from "./engine/settings";
import { setupSpace } from "./engine/setup";
import { startServer } from "./server/server";

// Keep launchd's log from growing forever; must run before anything logs.
trimLog(join(config().home, "engine.log"), 1024 * 1024);
stampConsole();
const crashMarker = join(config().home, "crashed");
installCrashGuard({ marker: crashMarker });

const url = `http://${config().host}:${config().port}`;
const db = openDb();
noteRestart(db, crashMarker);
const adapters = { claude: claudeAdapter(), codex: codexAdapter(), gemini: geminiAdapter() };
// Market time: the real clock, or the demo clock ATRIUM_MARKET_NOW shifts while the provider is Demo.
const marketClock = () => marketNow(getSetting(db, "markets.provider") ?? "finnhub");
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
// Steps the jobs skipped (no key yet) and missing earnings or metadata: on start, after a key is saved, and at
// most hourly from the feed's steps.
const catchUp = createCatchUp(db, { jobs, now: marketClock });
const catchUpLogged = (force: boolean) =>
  catchUp.run(force).catch((e) => console.error(`Market catch-up: ${redact(e instanceof Error ? e.message : String(e), data.secrets())}`));
// Mail and calendar sync only while a client is connected, when Inbox or Calendar opens, or when an Inbox task needs it.
const mail = createMail({ db });
// Repo work wakes the runner when a clone lands or a new project's space is ready.
const repos = createRepos({ db, kick: () => runner.kick() });
const runner = createRunner({
  db,
  adapters,
  power: powerSource,
  keepAwake,
  markets: createMarketsHooks(db, { data, now: marketClock }),
  repos,
  money: { daily: (now) => moneyDaily(db, now) },
  inbox: createInboxHooks(db, mail.sync),
});
const feed = createFeed({
  db,
  data,
  now: marketClock,
  onQuotes: (quotes) => evaluateQuotes(db, quotes, marketClock()),
  strategyActive: () => anyStrategyActive(db),
  onTick: (now) => enqueueDueStrategies(db, now, () => runner.kick()),
  jobs: {
    async runDue(now: number) {
      await jobs.runDue(now);
      await catchUpLogged(false);
    },
  },
});
onApprovalResolved((a, decision) => handleStrategyDecision(db, a, decision));
// The only path to creating, pushing or removing a repo: Nakul's own decision on its approval.
onApprovalResolved(repos.onDecision);
// Likewise the only path to sending a text: his own Send on its card.
const messaging = createMessaging({ db, kick: () => runner.kick() });
onApprovalResolved(messaging.onDecision);
// And to sending an email, an invite or a calendar change: his own Send or Approve on its card.
onApprovalResolved(mail.actions.onDecision);

// Bind before recovery: the port is the lock, so a second engine leaves the first one's tasks alone.
let server: ReturnType<typeof startServer>;
try {
  server = startServer({
    db,
    runner,
    setup: (text, onCreate) => setupSpace(db, claudeAdapter(), text, undefined, undefined, onCreate),
    onViewers: (n) => void feed.setViewers(n),
    markets: { data, feed, keychain, kick: () => runner.kick(), now: marketClock, jobs, catchUp },
    repos,
    messaging,
    mail,
    onClients: (n) => mail.sync.setClients(n),
  });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
  console.error(`Atrium is already running at ${url}`);
  process.exit(1);
}

// Texts and emails a stopped engine left mid-send, settled before anything awaits: the port is bound (it's the lock),
// but no request can run until this synchronous code yields, so no new Send can start in between.
recoverMessageActions(db);
recoverMailActions(db);
await recoverOnBoot(db);
// Before the runner starts, so no run works in a folder that is being moved.
for (const m of migrateSpaceFolders(db)) logActivity(db, m.spaceId, "atrium", `Moved this space's files to ${tildePath(m.to)}, where Finder can see them.`);
recoverRepoActions(db);
recoverRemovals(db);
// Files a delete queued but didn't get to remove before the engine stopped; their rows are already gone.
void finishPendingDeletes(db).catch((e) => console.error("Couldn't finish removing deleted files:", e));
runner.start();
repos.daily(Date.now());
void feed.start();
void catchUpLogged(true);
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
    mail.sync.stop();
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
