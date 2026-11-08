import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { setChosenProjectsRoot } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: ReturnType<typeof startServer>;
let base: string;
const FIX = join(import.meta.dir, "..", "fixtures");

beforeEach(() => {
  home = tempHome();
  db = openDb();
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "fake-claude.ts");
  process.env.ATRIUM_CODEX_BIN = "/nonexistent/codex";
  process.env.ATRIUM_GEMINI_BIN = "/nonexistent/agy";
  process.env.ATRIUM_GH_BIN = "/nonexistent/gh";
  server = startServer({ db, runner: { kick() {} }, setup: async () => { throw new Error("no"); }, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
  setChosenProjectsRoot(null);
  for (const k of ["ATRIUM_CLAUDE_BIN", "ATRIUM_CODEX_BIN", "ATRIUM_GEMINI_BIN", "ATRIUM_GH_BIN", "FAKE_CLAUDE_AUTH"]) delete process.env[k];
  home.cleanup();
});

const put = (path: string, body: unknown) => fetch(base + path, { method: "PUT", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /api/start gives the checks, the saved place and whether to open on its own", async () => {
  const r = await (await fetch(base + "/api/start")).json();
  expect(r.report.agents.map((a: { id: string; state: string }) => [a.id, a.state])).toEqual([["claude", "ready"], ["codex", "not_installed"], ["gemini", "not_installed"]]);
  expect(r.progress).toEqual({ step: "welcome", skipped: [], done: false });
  expect(r.autoOpen).toBe(true);
});

test("PUT /api/start moves and skips steps, and Done waits for Claude", async () => {
  expect(await (await put("/api/start", { skip: "tools", step: "investing" })).json()).toEqual({ step: "investing", skipped: ["tools"], done: false });
  process.env.FAKE_CLAUDE_AUTH = "signed-out";
  const blocked = await put("/api/start", { done: true });
  expect(blocked.status).toBe(400);
  expect((await blocked.json()).error).toContain("Claude comes first");
  delete process.env.FAKE_CLAUDE_AUTH;
  expect(await (await put("/api/start", { done: true })).json()).toMatchObject({ step: "done", done: true });
  expect((await (await fetch(base + "/api/start")).json()).autoOpen).toBe(false);
});

test("the profile keeps a name and a projects folder in settings, and the currency is read-only", async () => {
  const folder = join(home.home, "code");
  const saved = await (await put("/api/profile", { name: "Sam Rivera", projectsRoot: folder, homeCurrency: "USD" })).json();
  expect(saved).toMatchObject({ name: "Sam Rivera", projectsRoot: folder, homeCurrency: "CAD" });
  expect(db.query("SELECT value FROM settings WHERE key = 'projects.root'").get()).toEqual({ value: folder });
  const bad = await put("/api/profile", { projectsRoot: "nope" });
  expect(bad.status).toBe(400);
});
