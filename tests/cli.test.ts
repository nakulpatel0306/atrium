import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArgs, renderPlist, statusLine } from "../src/cli";
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
  const state = { spaces: [{}, {}], approvals: [{}] } as unknown as State;
  expect(statusLine(state, "http://127.0.0.1:7420")).toBe("running at http://127.0.0.1:7420 · 2 spaces · 1 needs you");
  expect(statusLine(null, "http://127.0.0.1:7420")).toBe("not running");
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
  expect(lines).toEqual(["Usage: atrium [tui [--high-contrast]|start|status|open|install|uninstall|app install|app uninstall|investing setup|doctor|data]"]);
});

test("investing setup asks the running engine once and says what happened", async () => {
  const { main } = await import("../src/cli");
  const seen: { method: string; path: string; origin: string | null }[] = [];
  let reply = { spaceId: "spc_1", created: true, added: 13 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push({ method: req.method, path: new URL(req.url).pathname, origin: req.headers.get("origin") });
      return Response.json(reply);
    },
  });
  const port = process.env.ATRIUM_PORT;
  const argv = process.argv;
  const live = server.port;
  process.env.ATRIUM_PORT = String(live);
  process.argv = [...argv.slice(0, 2), "investing", "setup"];
  const out: string[] = [];
  const log = console.log;
  console.log = (m: string) => void out.push(m);
  try {
    expect(await main("investing")).toBe(0);
    reply = { spaceId: "spc_1", created: false, added: 0 };
    expect(await main("investing")).toBe(0);
  } finally {
    console.log = log;
    process.argv = argv;
    if (port === undefined) delete process.env.ATRIUM_PORT;
    else process.env.ATRIUM_PORT = port;
    server.stop(true);
  }
  expect(seen).toEqual([
    { method: "POST", path: "/api/investing/setup", origin: `http://127.0.0.1:${live}` },
    { method: "POST", path: "/api/investing/setup", origin: `http://127.0.0.1:${live}` },
  ]);
  expect(out).toEqual(["Investing space ready. It's empty: import your holdings or add tickers in the dashboard.", "Investing space already set up."]);
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
  const data = run("data");
  expect(data.exitCode).toBe(0);
  expect(data.stdout.toString()).toContain(join(home(), "atrium.db"));
});
