#!/usr/bin/env bun
// Runs the terminal app under a real pty, types a script of keys, and returns what the screen showed.
// Usage: bun scripts/tui-screen.ts --port <p> [--cols 120] [--rows 36] [--keys "3,~300,?"] [--raw <file>]
import { Terminal } from "@xterm/headless";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export type Step = string | { wait: number };
export type Screen = { text: string; raw: string; exitCode: number | null };

const root = resolve(import.meta.dir, "..");
// Keys sent back to back can merge into one read; a short gap keeps each one its own keypress, as typed.
const KEY_GAP_MS = 60;
const EXIT_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NAMED: Record<string, string> = { "<esc>": "\x1b", "<enter>": "\r", "<tab>": "\t" };

export function parseKeys(script: string): Step[] {
  return script
    .split(",")
    .filter((s) => s !== "")
    .map((s) => (/^~\d+$/.test(s) ? { wait: Number(s.slice(1)) } : s.replace(/<esc>|<enter>|<tab>/g, (m) => NAMED[m]!)));
}

// The screen is read before a final "q", since quitting leaves the alternate screen and the app's frame with it.
// A script that doesn't end in "q" gets one sent after the read, so the app always exits on its own.
export async function screen(opts: { port: number; cols?: number; rows?: number; steps: Step[] }): Promise<Screen> {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 36;
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const decoder = new TextDecoder();
  let raw = "";
  let written = Promise.resolve();
  const proc = Bun.spawn(["bun", join(root, "src", "cli.ts")], {
    cwd: root,
    env: { ...process.env, ATRIUM_PORT: String(opts.port) },
    terminal: {
      cols,
      rows,
      data(_t, data) {
        raw += decoder.decode(data, { stream: true });
        const chunk = data.slice();
        written = written.then(() => new Promise<void>((r) => term.write(chunk, r)));
      },
    },
  });
  const send = (s: string) => proc.terminal!.write(s);
  const read = async () => {
    await written;
    const buf = term.buffer.active;
    return Array.from({ length: rows }, (_, i) => buf.getLine(i)?.translateToString(true) ?? "").join("\n");
  };

  const steps = [...opts.steps];
  const quits = steps.at(-1) === "q";
  if (quits) steps.pop();
  for (const step of steps) {
    if (typeof step === "string") {
      send(step);
      await sleep(KEY_GAP_MS);
    } else {
      await sleep(step.wait);
    }
  }
  // Let the last key's frame land before reading it.
  await sleep(150);
  const text = await read();
  send("q");
  const timer = setTimeout(() => proc.kill(), EXIT_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  await written;
  proc.terminal?.close();
  term.dispose();
  return { text, raw, exitCode };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      cols: { type: "string", default: "120" },
      rows: { type: "string", default: "36" },
      keys: { type: "string", default: "~1500" },
      raw: { type: "string" },
    },
  });
  if (!values.port) {
    console.error('Usage: bun scripts/tui-screen.ts --port <p> [--cols 120] [--rows 36] [--keys "3,~300,?"] [--raw <file>]');
    process.exit(1);
  }
  const result = await screen({
    port: Number(values.port),
    cols: Number(values.cols),
    rows: Number(values.rows),
    steps: parseKeys(values.keys!),
  });
  if (values.raw) await Bun.write(values.raw, result.raw);
  console.log(result.text);
  console.error(`exit ${result.exitCode}`);
}
