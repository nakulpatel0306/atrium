import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArgs, renderPlist, statusLine } from "../src/cli";
import { dataLocations, formatData } from "../src/engine/data-report";
import { openDb } from "../src/engine/db";
import { setSetting } from "../src/engine/settings";
import { trimLog } from "../src/engine/logfile";
import type { State } from "../src/engine/state";
import { tempHome } from "./helpers";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("renderPlist includes absolute paths, RunAtLoad, and log path", () => {
  const plist = renderPlist({
    bunPath: "/Users/me/.bun/bin/bun",
    mainPath: "/Users/me/atrium/src/main.ts",
    logPath: "/Users/me/Library/Application Support/Atrium/engine.log",
    workingDir: "/Users/me/atrium",
    pathEnv: "/Users/me/.local/bin:/usr/bin",
  });
  expect(plist).toContain("<string>/Users/me/.bun/bin/bun</string>");
  expect(plist).toContain("<string>/Users/me/atrium/src/main.ts</string>");
  expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
  expect(plist).toContain("<string>/Users/me/Library/Application Support/Atrium/engine.log</string>");
  expect(plist).toContain("<string>/Users/me/.local/bin:/usr/bin</string>");
  expect(plist).not.toContain("{{");
});

test("renderPlist escapes XML characters in paths", () => {
  const plist = renderPlist({ bunPath: "/a&b/bun", mainPath: "/a/src/main.ts", logPath: "/a/log" });
  expect(plist).toContain("/a&amp;b/bun");
});

test("statusLine is plain language", () => {
  const state = { spaces: [{}, {}], approvals: [{}], proposals: [], tasks: [] } as unknown as State;
  expect(statusLine(state, "http://127.0.0.1:7420")).toBe("running at http://127.0.0.1:7420 · 2 spaces · 1 needs you");
  expect(statusLine(null, "http://127.0.0.1:7420")).toBe("not running");
  const spent = { ...state, spend: { today: { weighted: 412_000, usd: 1.84, unpriced: 0, cacheRead: 0, input: 0 } } } as unknown as State;
  expect(statusLine(spent, "http://127.0.0.1:7420")).toBe("running at http://127.0.0.1:7420 · 2 spaces · 1 needs you · today 412k weighted tokens, ~$1.84 est.");
});

test("trimLog keeps only the last bytes of an oversized log", () => {
  const h = tempHome();
  cleanup = h.cleanup;
  const path = join(h.home, "engine.log");
  writeFileSync(path, "a".repeat(100) + "b".repeat(50));
  trimLog(path, 50);
  expect(readFileSync(path, "utf8")).toBe("b".repeat(50));
  trimLog(path, 50);
  expect(statSync(path).size).toBe(50);
  trimLog(join(h.home, "missing.log"), 50);
});

test("openArgs picks the app, passes a dev port, and falls back to the browser", () => {
  const appPath = "/Users/me/Applications/Atrium.app";
  const url = "http://127.0.0.1:7420";
  expect(openArgs({ appInstalled: true, appRunning: false, appPath, port: 7420, url })).toEqual(["open", appPath]);
  expect(openArgs({ appInstalled: true, appRunning: false, appPath, port: 7431, url })).toEqual(["open", "--env", "ATRIUM_PORT=7431", appPath]);
  expect(openArgs({ appInstalled: false, appRunning: false, appPath, port: 7420, url })).toEqual(["open", url]);
});

// open --env only reaches a fresh launch; a running copy would just come forward still pointing at its old port.
test("openArgs refuses a dev port while Atrium is already running", () => {
  const appPath = "/Users/me/Applications/Atrium.app";
  expect(openArgs({ appInstalled: true, appRunning: true, appPath, port: 7431, url: "http://127.0.0.1:7431" })).toEqual({
    error: "Quit Atrium first to open it on port 7431.",
  });
  expect(openArgs({ appInstalled: true, appRunning: true, appPath, port: 7420, url: "http://127.0.0.1:7420" })).toEqual(["open", appPath]);
});

test("usage lists tui", async () => {
  const { main } = await import("../src/cli");
  const lines: string[] = [];
  const err = console.error;
  console.error = (m: string) => void lines.push(m);
  try {
    expect(await main("bogus")).toBe(1);
  } finally {
    console.error = err;
  }
  expect(lines).toEqual(["Usage: atrium [tui [--high-contrast]|start|status|open|install|uninstall|app install|app uninstall|doctor|data [remove-old]]"]);
});

test("the removed investing command is just an unknown command", async () => {
  const { main } = await import("../src/cli");
  const err = console.error;
  console.error = () => {};
  try {
    expect(await main("investing")).toBe(1);
  } finally {
    console.error = err;
  }
});

test("atrium doctor and atrium data run from the command line", () => {
  const h = tempHome();
  cleanup = h.cleanup;
  const home = () => h.home;
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
      env: { ...process.env, ATRIUM_CLAUDE_BIN: join(import.meta.dir, "fixtures", "fake-claude.ts"), ATRIUM_CODEX_BIN: "/nonexistent/codex", ATRIUM_GEMINI_BIN: "/nonexistent/agy", ATRIUM_GH_BIN: "/nonexistent/gh", ATRIUM_HOME: home(), ATRIUM_FILES_HOME: join(home(), "files") },
    });
  const doctor = run("doctor");
  expect(doctor.exitCode).toBe(0);
  const text = doctor.stdout.toString();
  expect(text).toContain("ok       Claude 2.1.318 (required)");
  expect(text).toContain("missing  Codex (optional)");
  expect(text).toContain("npm install -g @openai/codex");
  // The saved projects folder is read from the database without opening it for writing.
  const db = openDb();
  setSetting(db, "projects.root", "/Users/me/Elsewhere");
  db.close();
  expect(run("doctor").stdout.toString()).toContain("Projects folder: /Users/me/Elsewhere");
  const data = run("data");
  expect(data.exitCode).toBe(0);
  expect(data.stdout.toString()).toContain(join(home(), "atrium.db"));
});

test("atrium data points an older install at remove-old, and a fresh one at nothing", () => {
  const h = tempHome();
  cleanup = h.cleanup;
  expect(formatData(dataLocations(), false)).not.toContain("remove-old");
  expect(formatData(dataLocations(), true)).toContain("Run `atrium data remove-old` to see exactly what's there and remove it.");
});

test("atrium data still reports when the database lost its -shm file", () => {
  const h = tempHome();
  cleanup = h.cleanup;
  const db = openDb();
  db.exec("CREATE TABLE money_accounts (id TEXT PRIMARY KEY)");
  db.close();
  rmSync(`${join(h.home, "atrium.db")}-shm`, { force: true });
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "data"], { env: process.env });
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toContain("atrium data remove-old");
});

// The real command, as typed: it lists what goes, and only a typed "remove" removes it.
function cliRemoveOld(answer: string) {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "data", "remove-old"], { stdin: Buffer.from(`${answer}\n`), env: process.env });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

test("atrium data remove-old lists, asks, and removes only on yes", () => {
  const h = tempHome();
  cleanup = () => {
    delete process.env.FAKE_SECURITY_STORE;
    h.cleanup();
  };
  process.env.FAKE_SECURITY_STORE = join(h.home, "keychain.json");
  writeFileSync(process.env.FAKE_SECURITY_STORE, JSON.stringify({ "Atrium/tiingo.token": "abc123" }));
  expect(cliRemoveOld("remove")).toEqual({ code: 0, out: expect.stringContaining("Nothing is left from features Atrium no longer has.") });
  const db = openDb();
  db.exec("CREATE TABLE money_accounts (id TEXT PRIMARY KEY); INSERT INTO money_accounts VALUES ('a1')");
  setSetting(db, "money.lastDaily", "1");
  db.close();
  const no = cliRemoveOld("no");
  expect(no.out).toContain("Money: 1 row in money_accounts (1)");
  expect(no.out).toContain('Keychain items (service "Atrium"): tiingo.token');
  expect(no.out).toContain("Nothing was removed.");
  const yes = cliRemoveOld("remove");
  expect(yes.code).toBe(0);
  expect(yes.out).toContain("Removed the old data: 1 row and 1 Keychain item.");
  expect(JSON.parse(readFileSync(process.env.FAKE_SECURITY_STORE, "utf8"))).toEqual({});
  const after = openDb();
  expect(after.query("SELECT name FROM sqlite_master WHERE name = 'money_accounts'").get()).toBeNull();
  after.close();
});
