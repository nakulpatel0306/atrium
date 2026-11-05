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
    bunPath: "/Users/x/.bun/bin/bun",
    mainPath: "/Users/x/atrium/src/main.ts",
    logPath: "/Users/x/Library/Application Support/Atrium/engine.log",
    workingDir: "/Users/x/atrium",
    pathEnv: "/Users/x/.local/bin:/usr/bin",
  });
  expect(plist).toContain("<string>/Users/x/.bun/bin/bun</string>");
  expect(plist).toContain("<string>/Users/x/atrium/src/main.ts</string>");
  expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
  expect(plist).toContain("<string>/Users/x/Library/Application Support/Atrium/engine.log</string>");
  expect(plist).toContain("<string>/Users/x/.local/bin:/usr/bin</string>");
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
  const appPath = "/Users/x/Applications/Atrium.app";
  const url = "http://127.0.0.1:7420";
  expect(openArgs({ appInstalled: true, appRunning: false, appPath, port: 7420, url })).toEqual(["open", appPath]);
  expect(openArgs({ appInstalled: true, appRunning: false, appPath, port: 7431, url })).toEqual(["open", "--env", "ATRIUM_PORT=7431", appPath]);
  expect(openArgs({ appInstalled: false, appRunning: false, appPath, port: 7420, url })).toEqual(["open", url]);
});

// open --env only reaches a fresh launch; a running copy would just come forward still pointing at its old port.
test("openArgs refuses a dev port while Atrium is already running", () => {
  const appPath = "/Users/x/Applications/Atrium.app";
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
  expect(lines).toEqual(["Usage: atrium [tui|start|status|open|install|uninstall|app install|app uninstall]"]);
});
