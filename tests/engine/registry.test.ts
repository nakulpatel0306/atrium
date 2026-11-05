import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentStatus } from "../../src/engine/agents/types";
import { openDb } from "../../src/engine/db";
import { createRegistry } from "../../src/engine/agents/registry";
import { createSpace, getSpace } from "../../src/engine/spaces";
import { createTask } from "../../src/engine/tasks";
import { tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
  while (cleanups.length) cleanups.pop()!();
});

const READY: AgentStatus = { installed: true, loggedIn: true, detail: "ok" };

function fake(id: string, status: AgentStatus = READY): AgentAdapter {
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    run: async () => ({ status: "ok", summary: "", inputTokens: 0, outputTokens: 0 }),
    probe: async () => status,
  };
}

async function registry(statuses: Partial<Record<"claude" | "codex" | "gemini", AgentStatus>> = {}) {
  const r = createRegistry(db, {
    claude: fake("claude", statuses.claude),
    codex: fake("codex", statuses.codex),
    gemini: fake("gemini", statuses.gemini),
  });
  await r.refresh();
  return r;
}

const LOGGED_OUT: AgentStatus = { installed: true, loggedIn: false, detail: "Sign in first." };
const MISSING: AgentStatus = { installed: false, loggedIn: null, detail: "not installed" };

const privateSpace = () => createSpace(db, { name: "Notes", kind: "general", goal: "", private: true });
const openSpace = () => createSpace(db, { name: "Docs", kind: "general", goal: "", private: false });
function repoSpace(opts: { private?: boolean } = {}) {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  return { space: createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: r.path, private: opts.private ?? false }), path: r.path };
}
const task = (spaceId: string, extra: Partial<Parameters<typeof createTask>[1]> = {}) =>
  createTask(db, { spaceId, title: "t", agent: "auto", ...extra });

function resolveFor(r: ReturnType<typeof createRegistry>, t: ReturnType<typeof task>, spaceId: string) {
  return r.resolve(t, getSpace(db, spaceId)!);
}

test("auto picks claude for private spaces", async () => {
  const r = await registry();
  const s = privateSpace();
  expect(resolveFor(r, task(s.id, { kind: "review" }), s.id)).toEqual({ agent: "claude" });
});

test("auto picks claude for repo work", async () => {
  const r = await registry();
  const { space } = repoSpace();
  expect(resolveFor(r, task(space.id), space.id)).toEqual({ agent: "claude" });
  expect(resolveFor(r, task(space.id, { kind: "fix" }), space.id)).toEqual({ agent: "claude" });
});

test("auto picks codex for reviews", async () => {
  const r = await registry();
  const { space } = repoSpace();
  expect(resolveFor(r, task(space.id, { kind: "review" }), space.id)).toEqual({ agent: "codex" });
});

test("auto uses gemini for reviews when codex is logged out", async () => {
  const r = await registry({ codex: LOGGED_OUT });
  const { space } = repoSpace();
  expect(resolveFor(r, task(space.id, { kind: "review" }), space.id)).toEqual({ agent: "gemini" });
});

test("auto falls back to claude when both free agents are unavailable", async () => {
  const r = await registry({ codex: MISSING, gemini: LOGGED_OUT });
  const { space } = repoSpace();
  expect(resolveFor(r, task(space.id, { kind: "review" }), space.id)).toEqual({ agent: "claude" });
});

test("auto skips a free agent that is at its usage limit", async () => {
  const r = await registry();
  r.setLimited("codex", Date.now() + 60_000);
  const { space } = repoSpace();
  expect(resolveFor(r, task(space.id, { kind: "review" }), space.id)).toEqual({ agent: "gemini" });
});

test("auto keeps a repo review on claude when the repo has .env files", async () => {
  const r = await registry();
  const { space, path } = repoSpace();
  writeFileSync(join(path, ".gitignore"), ".env\n");
  writeFileSync(join(path, ".env"), "X=1\n");
  expect(resolveFor(r, task(space.id, { kind: "review" }), space.id)).toEqual({ agent: "claude" });
});

test("auto picks codex for general non-private work while claude is in reserve", async () => {
  const r = await registry();
  const s = openSpace();
  expect(resolveFor(r, task(s.id), s.id)).toEqual({ agent: "claude" });
  r.recordUsage("claude", { fiveHour: { utilization: 0.6, resetsAt: Date.now() + 3600_000 } });
  expect(resolveFor(r, task(s.id), s.id)).toEqual({ agent: "codex" });
});

test("explicit codex in a repo with .env waits with the secret reason", async () => {
  const r = await registry();
  const { space, path } = repoSpace();
  writeFileSync(join(path, ".gitignore"), ".env\n");
  writeFileSync(join(path, ".env"), "X=1\n");
  expect(resolveFor(r, task(space.id, { agent: "codex" }), space.id)).toEqual({
    wait: "Codex can't work here: this repo has .env files Codex could read. Use Claude for this task.",
  });
});

test("an untracked .env that git doesn't ignore also counts", async () => {
  const r = await registry();
  const { space, path } = repoSpace();
  writeFileSync(join(path, "pkg.env.example"), "");
  writeFileSync(join(path, ".env.local"), "X=1\n");
  expect(resolveFor(r, task(space.id, { agent: "gemini", kind: "review" }), space.id)).toEqual({
    wait: "Gemini can't work here: this repo has .env files Gemini could read. Use Claude for this task.",
  });
});

function codexWaitsOn(spaceId: string) {
  const r = createRegistry(db, { claude: fake("claude"), codex: fake("codex") });
  return r.resolve(task(spaceId, { agent: "codex" }), getSpace(db, spaceId)!);
}
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const SECRET_WAIT = { wait: "Codex can't work here: this repo has .env files Codex could read. Use Claude for this task." };

test("a .env under a different name pattern or in a subfolder counts", () => {
  const { space, path } = repoSpace();
  mkdirSync(join(path, "config"));
  writeFileSync(join(path, "config", "prod.env"), "X=1\n");
  expect(codexWaitsOn(space.id)).toEqual(SECRET_WAIT);
});

test("a space pointing at a subfolder checks the whole repo", () => {
  const { space, path } = repoSpace();
  mkdirSync(join(path, "pkg"));
  writeFileSync(join(path, "pkg", "keep"), "");
  writeFileSync(join(path, ".env"), "X=1\n");
  db.query("UPDATE spaces SET repo_path = ? WHERE id = ?").run(join(path, "pkg"), space.id);
  expect(codexWaitsOn(space.id)).toEqual(SECRET_WAIT);
});

test("an untracked nested repo is treated as holding .env files", () => {
  const { space, path } = repoSpace();
  mkdirSync(join(path, "vendor"));
  git(join(path, "vendor"), "init", "-q");
  expect(codexWaitsOn(space.id)).toEqual(SECRET_WAIT);
});

test("a submodule gitlink is treated as holding .env files", () => {
  const { space, path } = repoSpace();
  const sha = git(path, "rev-parse", "HEAD");
  git(path, "update-index", "--add", "--cacheinfo", `160000,${sha},mod`);
  expect(codexWaitsOn(space.id)).toEqual(SECRET_WAIT);
});

test("a clean repo lets codex in", () => {
  const { space, path } = repoSpace();
  expect(codexWaitsOn(space.id)).toEqual({ agent: "codex" });
});

test("explicit codex in a private space waits", async () => {
  const r = await registry();
  const s = privateSpace();
  expect(resolveFor(r, task(s.id, { agent: "codex" }), s.id)).toEqual({
    wait: "Codex can't work here: this space is private, so only Claude works in it.",
  });
});

test("explicit gemini never does repo work", async () => {
  const r = await registry();
  const { space } = repoSpace();
  const msg = "Gemini only reviews code; pick Claude or Codex for repo work.";
  expect(resolveFor(r, task(space.id, { agent: "gemini" }), space.id)).toEqual({ wait: msg });
  expect(resolveFor(r, task(space.id, { agent: "gemini", kind: "review" }), space.id)).toEqual({ agent: "gemini" });
  const s = openSpace();
  expect(resolveFor(r, task(s.id, { agent: "gemini" }), s.id)).toEqual({ agent: "gemini" });
});

test("an explicit agent that is logged out or missing waits with the fix", async () => {
  const r = await registry({ codex: LOGGED_OUT, gemini: MISSING });
  const s = openSpace();
  expect(resolveFor(r, task(s.id, { agent: "codex" }), s.id)).toEqual({ wait: "Codex is signed out. Sign in first." });
  expect(resolveFor(r, task(s.id, { agent: "gemini" }), s.id)).toEqual({
    wait: "Gemini isn't installed. Install it, or pick another agent for this task.",
  });
});

test("claude in reserve waits; ignore_reserve runs", async () => {
  const r = await registry();
  const s = privateSpace();
  const resetsAt = Date.now() + 3600_000;
  r.recordUsage("claude", { fiveHour: { utilization: 0.6, resetsAt } });
  expect(r.inReserve()).toEqual({ until: resetsAt });
  const time = new Date(resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  expect(resolveFor(r, task(s.id), s.id)).toEqual({
    wait: `Saving the rest of your Claude window for you (resets ${time}). Use “Run now” to override.`,
  });
  expect(resolveFor(r, task(s.id, { ignoreReserve: true }), s.id)).toEqual({ agent: "claude" });
});

test("reserve clears after resetsAt passes", async () => {
  const r = await registry();
  r.recordUsage("claude", { fiveHour: { utilization: 0.9, resetsAt: Date.now() - 1 } });
  expect(r.inReserve()).toBeNull();
});

test("reserve is below the usage.claude.reserve setting", async () => {
  const r = await registry();
  r.recordUsage("claude", { fiveHour: { utilization: 0.4, resetsAt: Date.now() + 60_000 } });
  expect(r.inReserve()).toBeNull();
  db.query("INSERT INTO settings (key, value) VALUES ('usage.claude.reserve', '0.3')").run();
  expect(r.inReserve()).not.toBeNull();
});

test("limitedUntil is tracked per agent and shown in statuses", async () => {
  const r = await registry({ gemini: LOGGED_OUT });
  const until = Date.now() + 60_000;
  r.setLimited("codex", until);
  expect(r.limitedUntil("codex")).toBe(until);
  expect(r.limitedUntil("claude")).toBe(0);
  expect(r.statuses().codex).toMatchObject({ installed: true, limitedUntil: until });
  expect(r.statuses().claude!.limitedUntil).toBeNull();
  expect(r.statuses().gemini).toMatchObject({ loggedIn: false, detail: "Sign in first." });
});

test("refresh probes only every ten minutes and survives a failing probe", async () => {
  let probes = 0;
  const flaky: AgentAdapter = {
    ...fake("codex"),
    probe: async () => {
      probes++;
      throw new Error("boom");
    },
  };
  const r = createRegistry(db, { claude: fake("claude"), codex: flaky });
  await r.refresh();
  await r.refresh();
  expect(probes).toBe(1);
  expect(r.statuses().codex).toMatchObject({ installed: true, loggedIn: null });
  expect(r.statuses().codex!.detail).toContain("boom");
});

test("an adapter with no probe counts as available", () => {
  const { probe: _, ...bare } = fake("claude");
  const r = createRegistry(db, { claude: bare });
  const s = privateSpace();
  expect(resolveFor(r, task(s.id), s.id)).toEqual({ agent: "claude" });
});
