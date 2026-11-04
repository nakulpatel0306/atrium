import { join } from "node:path";
import { claudeAdapter } from "./engine/agents/claude";
import { config } from "./engine/config";
import { openDb } from "./engine/db";
import { trimLog } from "./engine/logfile";
import { keepAwake, powerSource } from "./engine/power";
import { createRunner, recoverOnBoot } from "./engine/runner";
import { setupSpace } from "./engine/setup";
import { startServer } from "./server/server";

// Keep launchd's log from growing forever; must run before anything logs.
trimLog(join(config().home, "engine.log"), 1024 * 1024);

const url = `http://${config().host}:${config().port}`;
const db = openDb();
const runner = createRunner({ db, adapters: { claude: claudeAdapter() }, power: powerSource, keepAwake });

// Bind before recovery: the port is the lock, so a second engine leaves the first one's tasks alone.
let server: ReturnType<typeof startServer>;
try {
  server = startServer({ db, runner, setup: (text) => setupSpace(db, claudeAdapter(), text) });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
  console.error(`Atrium is already running at ${url}`);
  process.exit(1);
}

recoverOnBoot(db);
runner.start();
console.log(`Atrium running at ${url}`);

const shutdown = async () => {
  await runner.stop();
  keepAwake.stop();
  // Open dashboard sockets would otherwise keep shutdown waiting forever.
  await server.stop(true);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
