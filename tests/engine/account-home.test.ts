import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountHome } from "../../src/engine/agents/account-home";

// ssh, git and most tools find the home folder by user id, not $HOME. An engine started with another HOME must deny
// under the account's own home everything it denies under $HOME. Bun reads $HOME once at startup, so each check
// runs in a process started with HOME pointing elsewhere.
const SRC = join(import.meta.dir, "..", "..", "src", "engine");
let elsewhere: string;
let cwd: string;
let account: string;

type Seen = { claudeDenyRead: string[]; claudeRules: string[]; atrium: string[]; codex: string; gemini: string; privateNoBash: string[]; privateRules: string[] };

function underElsewhere(): Seen {
  const script = `
const c = await import(${JSON.stringify(join(SRC, "agents", "claude.ts"))});
const { atriumDenyPaths } = await import(${JSON.stringify(join(SRC, "agents", "atrium-paths.ts"))});
const { codexArgv } = await import(${JSON.stringify(join(SRC, "agents", "codex.ts"))});
const { geminiArgv } = await import(${JSON.stringify(join(SRC, "agents", "gemini.ts"))});
const { privateReads, privateReadRules } = await import(${JSON.stringify(join(SRC, "agents", "private-paths.ts"))});
const cwd = ${JSON.stringify(cwd)};
const input = { prompt: "p", systemPrompt: "s", cwd, mode: "work", allowedTools: [], onChunk: () => {} };
console.log(JSON.stringify({
  claudeDenyRead: JSON.parse(c.sandboxSettings(cwd)).sandbox.filesystem.denyRead,
  claudeRules: c.denyRules(cwd),
  atrium: atriumDenyPaths(cwd),
  codex: codexArgv("codex", input, "/tmp/x")[2],
  gemini: geminiArgv("agy", input, "/tmp/x")[2],
  privateNoBash: privateReads(cwd, { bash: false }).denyRead,
  privateRules: privateReadRules(cwd),
}));`;
  const env: Record<string, string | undefined> = { ...process.env, HOME: elsewhere };
  for (const k of ["ATRIUM_USER_HOME", "CODEX_HOME"]) delete env[k];
  const r = Bun.spawnSync(["bun", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
}

let seen: Seen;
beforeAll(() => {
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "atrium-other-home-")));
  cwd = join(elsewhere, "repo");
  mkdirSync(cwd);
  account = accountHome()!;
  seen = underElsewhere();
});
afterAll(() => rmSync(elsewhere, { recursive: true, force: true }));

test("the account's home is found from the user database, not $HOME", () => {
  if (process.platform !== "darwin") return;
  expect(account).toBeTruthy();
  expect(account).not.toBe(elsewhere);
});

test("Claude's sandbox denies .env files under the account's home too", () => {
  if (process.platform !== "darwin") return;
  for (const g of [".env*", "*.env", ".[eE][nN][vV]*", "*.[eE][nN][vV]"]) expect(seen.claudeDenyRead).toContain(`${account}/**/${g}`);
});

test("Atrium's real data and files folders under the account's home are denied", () => {
  if (process.platform !== "darwin") return;
  expect(seen.atrium).toContain(join(account, "Library", "Application Support", "Atrium"));
  expect(seen.atrium).toContain(join(account, "Atrium"));
});

test("Codex can't read the account's ~/.gemini, and Gemini can't read its ~/.codex", () => {
  if (process.platform !== "darwin") return;
  expect(seen.codex).toContain(`(subpath "${realpathSync(account)}/.gemini")`);
  expect(seen.gemini).toContain(`(subpath "${realpathSync(account)}/.codex")`);
});

test("a private run's reads are fenced from the account's home as well", () => {
  if (process.platform !== "darwin") return;
  expect(seen.privateNoBash).toContain(realpathSync(account));
  expect(seen.privateRules.some((r) => r.startsWith(`Read(/${realpathSync(account)}/`) || r === `Read(/${realpathSync(account)})`)).toBe(true);
});
