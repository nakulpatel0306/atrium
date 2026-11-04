import { claudeAdapter } from "./engine/agents/claude";
import { config } from "./engine/config";
import { openDb } from "./engine/db";
import { keepAwake, powerSource } from "./engine/power";
import { createRunner, recoverOnBoot } from "./engine/runner";
import { setupSpace } from "./engine/setup";
import { startServer } from "./server/server";

const db = openDb();
recoverOnBoot(db);
const runner = createRunner({ db, adapters: { claude: claudeAdapter() }, power: powerSource, keepAwake });
runner.start();
const server = startServer({ db, runner, setup: (text) => setupSpace(db, claudeAdapter(), text) });

console.log(`Atrium running at http://${config().host}:${server.port}`);

const shutdown = async () => {
  await runner.stop();
  keepAwake.stop();
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
