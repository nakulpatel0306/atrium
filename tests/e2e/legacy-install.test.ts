// The server over a database shaped like an install from before Markets, Money, Mail and texting were cut.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/engine/db";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: ReturnType<typeof startServer>;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.exec("INSERT INTO spaces (id, name, kind, goal, color, private, status, created_at, updated_at) VALUES ('spc_inv', 'Investing', 'markets', '', '#fff', 1, 'active', 1, 1)");
  db.exec("PRAGMA ignore_check_constraints = OFF");
  db.exec("CREATE TABLE market_holdings (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id)); INSERT INTO market_holdings VALUES ('h1', 'spc_inv')");
  server = startServer({ db, runner: { kick() {} }, setup: async () => { throw new Error("not used"); }, port: 0 });
});
afterEach(() => {
  server.stop(true);
  db.close();
  home.cleanup();
});

test("the engine serves an old Investing space as a plain general space and keeps its old rows", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  expect(state.spaces).toMatchObject([{ id: "spc_inv", name: "Investing", kind: "general", private: true }]);
  expect(state.embed).toBeUndefined();
  expect((await fetch(`${base}/api/summary`)).status).toBe(200);
  const renamed = await fetch(`${base}/api/spaces/spc_inv`, { method: "PATCH", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ name: "Notes" }) });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ name: "Notes", kind: "general" });
  expect(db.query("SELECT COUNT(*) AS n FROM market_holdings").get()).toEqual({ n: 1 });
  for (const gone of ["/api/investing/setup", "/api/markets/spc_inv", "/api/mail/overview"]) expect((await fetch(`${base}${gone}`)).status).toBe(404);
});
