#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "./engine/config";
import type { State } from "./engine/state";

const LABEL = "com.atrium.engine";
const root = resolve(import.meta.dir, "..");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${process.getuid?.() ?? 501}`;

export type PlistOpts = { bunPath: string; mainPath: string; logPath: string; workingDir?: string; pathEnv?: string };

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
      return run(["open", url()]).ok ? 0 : fail("Couldn't open your browser.");
    case "install":
      return install();
    case "uninstall":
      return uninstall();
    default:
      return fail("Usage: atrium [tui|start|status|open|install|uninstall]");
  }
}

if (import.meta.main) {
  const code = await main(process.argv[2]);
  if (code >= 0) process.exit(code);
}
