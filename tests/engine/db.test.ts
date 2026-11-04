import { expect, test } from "bun:test";
import { join } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { tempHome } from "../helpers";

test("openDb creates all tables", () => {
  const t = tempHome();
  const db = openDb();
  const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const n of ["spaces", "tasks", "runs", "approvals", "activity", "settings"]) expect(names).toContain(n);
  db.close();
  t.cleanup();
});

test("openDb is idempotent", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  openDb(path).close();
  const db = openDb(path);
  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");
  db.close();
  t.cleanup();
});

test("config honors ATRIUM_HOME", () => {
  const t = tempHome();
  expect(config().home).toBe(t.home);
  expect(config().dbPath.endsWith("atrium.db")).toBe(true);
  t.cleanup();
});
