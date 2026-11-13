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
import { createRepos } from "./engine/repos";
import { recoverRemovals } from "./engine/repos/cleanup";
import { finishPendingDeletes } from "./engine/delete-files";
import { recoverRepoActions } from "./engine/repos/create";
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
// Repo work wakes the runner when a clone lands or a new project's space is ready.
const repos = createRepos({ db, kick: () => runner.kick() });
const runner = createRunner({
  db,
  adapters,
  power: powerSource,
  keepAwake,
  repos,
});
// The only path to creating, pushing or removing a repo: Nakul's own decision on its approval.
onApprovalResolved(repos.onDecision);

// Bind before recovery: the port is the lock, so a second engine leaves the first one's tasks alone.
let server: ReturnType<typeof startServer>;
try {
  server = startServer({
    db,
    runner,
    setup: (text, onCreate) => setupSpace(db, claudeAdapter(), text, undefined, undefined, onCreate),
    repos,
  });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
  console.error(`Atrium is already running at ${url}`);
  process.exit(1);
}

await recoverOnBoot(db);
// Before the runner starts, so no run works in a folder that is being moved.
for (const m of migrateSpaceFolders(db)) logActivity(db, m.spaceId, "atrium", `Moved this space's files to ${tildePath(m.to)}, where Finder can see them.`);
recoverRepoActions(db);
recoverRemovals(db);
// Files a delete queued but didn't get to remove before the engine stopped; their rows are already gone.
void finishPendingDeletes(db).catch((e) => console.error("Couldn't finish removing deleted files:", e));
runner.start();
repos.daily(Date.now());
console.log(`Atrium running at ${url}`);

let stopping = false;
const shutdown = async () => {
  // launchd and Ctrl-C can both signal; a second stop would race the first.
  if (stopping) return;
  stopping = true;
  console.log("Atrium stopping");
  let code = 0;
  try {
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
