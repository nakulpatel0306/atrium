#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "./engine/config";
import type { State } from "./engine/state";
import { buildApp } from "./mac/build";
import { APP_ID, xml } from "./mac/plists";

export { APP_ID };

const LABEL = "com.atrium.engine";
const root = resolve(import.meta.dir, "..");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${process.getuid?.() ?? 501}`;
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const USAGE = "Usage: atrium [tui|start|status|open|install|uninstall|app install|app uninstall]";

export const appPath = () => join(homedir(), "Applications", "Atrium.app");

// A dev engine's port has to reach the app, which otherwise points at the installed engine on 7420.
export function openArgs(o: { appInstalled: boolean; appPath: string; port: number; url: string }): string[] {
  if (!o.appInstalled) return ["open", o.url];
  return o.port === 7420 ? ["open", o.appPath] : ["open", "--env", `ATRIUM_PORT=${o.port}`, o.appPath];
}

export type PlistOpts = { bunPath: string; mainPath: string; logPath: string; workingDir?: string; pathEnv?: string };

export function renderPlist(opts: PlistOpts): string {
  const values: Record<string, string> = {
    BUN: opts.bunPath,
    MAIN: opts.mainPath,
    WORKDIR: opts.workingDir ?? dirname(dirname(opts.mainPath)),
    PATH: opts.pathEnv ?? "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    LOG: opts.logPath,
  };
  const template = readFileSync(join(root, "scripts", `${LABEL}.plist`), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => xml(values[key] ?? ""));
}

export function statusLine(state: State | null, url: string): string {
  if (!state) return "not running";
  const n = state.spaces.length;
  const needs = state.approvals.length;
  const parts = [`running at ${url}`, `${n} ${n === 1 ? "space" : "spaces"}`];
  parts.push(needs > 0 ? `${needs} needs you` : "nothing needs you");
  return parts.join(" · ");
}

const url = () => `http://${config().host}:${config().port}`;

async function fetchState(): Promise<State | null> {
  try {
    const res = await fetch(`${url()}/api/state`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? ((await res.json()) as State) : null;
  } catch {
    return null;
  }
}

function run(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

const isLoaded = () => run(["launchctl", "print", `${domain}/${LABEL}`]).ok;
const portListener = () => run(["lsof", `-iTCP:${config().port}`, "-sTCP:LISTEN", "-t"]).out;

function install(): number {
  const bunPath = run(["which", "bun"]).out;
  const claudePath = run(["which", "claude"]).out;
  if (!bunPath) return fail("Can't find bun on your PATH, so Atrium can't be installed.");
  if (!claudePath) return fail("Can't find the claude command on your PATH. Install Claude Code first, then run this again.");

  // Reinstalling replaces the old job, so unload it before checking who owns the port.
  if (isLoaded()) run(["launchctl", "bootout", `${domain}/${LABEL}`]);
  if (portListener()) {
    return fail(`Something is already listening on port ${config().port}, so Atrium wasn't installed. Stop it first (see: lsof -iTCP:${config().port} -sTCP:LISTEN), then run atrium install again.`);
  }

  const home = config().home;
  mkdirSync(home, { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });
  const pathEnv = [...new Set([dirname(claudePath), dirname(bunPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"])].join(":");
  writeFileSync(
    plistPath,
    renderPlist({ bunPath, mainPath: join(root, "src", "main.ts"), logPath: join(home, "engine.log"), workingDir: root, pathEnv }),
  );
  const r = run(["launchctl", "bootstrap", domain, plistPath]);
  if (!r.ok) return fail(`launchctl couldn't start Atrium: ${r.err || r.out}`);
  console.log("Installed. Atrium will start at login and is running now.");
  return 0;
}

function uninstall(): number {
  if (isLoaded()) run(["launchctl", "bootout", `${domain}/${LABEL}`]);
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log("Atrium will no longer start at login.");
  return 0;
}

const quitApp = () => run(["osascript", "-e", `quit app id "${APP_ID}"`]);

async function appInstall(): Promise<number> {
  const out = mkdtempSync(join(tmpdir(), "atrium-app-"));
  try {
    const built = await buildApp({ outDir: out });
    quitApp();
    rmSync(appPath(), { recursive: true, force: true });
    mkdirSync(dirname(appPath()), { recursive: true });
    const copy = run(["ditto", built, appPath()]);
    if (!copy.ok) return fail(`Couldn't copy Atrium into ~/Applications: ${copy.err || copy.out}`);
    run([LSREGISTER, "-f", appPath()]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  console.log("Installed Atrium in ~/Applications. Open it with: atrium open");
  return 0;
}

function appUninstall(): number {
  if (!existsSync(appPath())) {
    console.log("Atrium isn't installed in ~/Applications.");
    return 0;
  }
  // Unregistering needs the app's own bundle, so it runs before the bundle is removed.
  run([join(appPath(), "Contents", "MacOS", "Atrium"), "--unregister-login"]);
  quitApp();
  run([LSREGISTER, "-u", appPath()]);
  rmSync(appPath(), { recursive: true, force: true });
  console.log("Removed Atrium from ~/Applications. The engine keeps running; use atrium uninstall to stop it starting at login.");
  return 0;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

export async function main(cmd: string | undefined): Promise<number> {
  switch (cmd) {
    case undefined:
    case "tui":
      await import("./tui/main");
      return -1;
    case "start":
      await import("./main");
      return -1;
    case "status":
      console.log(statusLine(await fetchState(), url()));
      return 0;
    case "open":
      return run(openArgs({ appInstalled: existsSync(appPath()), appPath: appPath(), port: config().port, url: url() })).ok
        ? 0
        : fail("Couldn't open Atrium.");
    case "install":
      return install();
    case "uninstall":
      return uninstall();
    case "app":
      if (process.argv[3] === "install") return appInstall();
      if (process.argv[3] === "uninstall") return appUninstall();
      return fail(USAGE);
    default:
      return fail(USAGE);
  }
}

if (import.meta.main) {
  const code = await main(process.argv[2]);
  if (code >= 0) process.exit(code);
}
