// An engine API in a process of its own, with two spaces to delete, for the sandbox test: the test's own event
// loop stays free, so a request that got through would really be answered. Prints its port and the space ids.
import { openDb } from "../../src/engine/db";
import { createSpace } from "../../src/engine/spaces";
import { startServer } from "../../src/server/server";

const db = openDb();
const server = startServer({ db, runner: { kick: () => {} }, setup: async () => ({}) as never, port: 0 });
const ids = [1, 2].map(() => createSpace(db, { name: "Text Dana", kind: "general", goal: "g" }).id);
console.log(JSON.stringify({ port: server.port, ids }));
process.on("SIGTERM", () => {
  server.stop(true);
  db.close();
  process.exit(0);
});
