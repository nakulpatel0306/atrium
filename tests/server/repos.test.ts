import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApproval, onApprovalResolved } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { createRepos, type Repos } from "../../src/engine/repos";
import { draftProject, getRepoAction, listClones } from "../../src/engine/repos/store";
import type { SetupResult } from "../../src/engine/setup";
import { createSpace } from "../../src/engine/spaces";
import type { State } from "../../src/engine/state";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome } from "../helpers";
import { type FakeGitHub, fakeGitHub } from "../repos-helpers";

// Creating a project spawns git and the fake gh several times; slow under load.
setDefaultTimeout(30_000);

let home: ReturnType<typeof tempHome>;
let db: Database;
let gh: FakeGitHub;
let repos: Repos;
let server: Server<WsData>;
let base: string;
let setupImpl: (text: string) => Promise<SetupResult>;
let unsubscribe: () => void;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  gh = fakeGitHub();
  repos = createRepos({ db, kick: () => {} });
  unsubscribe = onApprovalResolved(repos.onDecision);
  setupImpl = async () => {
    throw new Error("setup not stubbed");
  };
  server = startServer({ db, runner: { kick: () => {} }, setup: (t) => setupImpl(t), port: 0, repos });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  await repos.settle();
  unsubscribe();
  server.stop(true);
  db.close();
  gh.cleanup();
  home.cleanup();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = { origin: base }) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const fields = { name: "demo", description: "A demo", visibility: "private", template: "bun-ts" };
const draft = () => draftProject(db, { name: "demo", description: "A demo", visibility: "private", template: "bun-ts" });
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;

test("a bad name is refused inline and the draft stays as it was", async () => {
  const { action, approval } = draft();
  const r = await post(`/api/repo-actions/${action.id}/approve`, { ...fields, name: "--foo" });
  expect(r.status).toBe(400);
  expect(await errorOf(r)).toMatch(/^Repo names use letters/);
  const a = getApproval(db, approval.id)!;
  expect(a.status).toBe("pending");
  expect(a.title).toBe('Create GitHub repo "demo"?');
});

test("a name taken in another case is refused with the folder message", async () => {
  const { action, approval } = draft();
  mkdirSync(join(gh.projects, "Other"));
  const r = await post(`/api/repo-actions/${action.id}/approve`, { ...fields, name: "other" });
  expect(r.status).toBe(400);
  expect(await errorOf(r)).toMatch(/^A folder named "Other" already exists/);
  expect(getApproval(db, approval.id)!.status).toBe("pending");
});

test("approving runs the create, and a second approve is already handled", async () => {
  const { action } = draft();
  const r = await post(`/api/repo-actions/${action.id}/approve`, { ...fields, name: "demo-2" });
  expect(r.status).toBe(200);
  await repos.settle();
  expect(getRepoAction(db, action.id)!.status).toBe("done");
  const state = (await (await fetch(`${base}/api/state`)).json()) as State;
  expect(state.spaces.map((s) => s.github)).toEqual(["fakeuser/demo-2"]);
  const again = await post(`/api/repo-actions/${action.id}/approve`, fields);
  expect(again.status).toBe(409);
  expect(await errorOf(again)).toBe("Already handled");
});

test("an unknown draft is 404", async () => {
  expect((await post("/api/repo-actions/rpa_nope/approve", fields)).status).toBe(404);
});

test("POST routes need our Origin", async () => {
  const { action } = draft();
  for (const path of [`/api/repo-actions/${action.id}/approve`, "/api/clones/cln_x/ask-remove"]) {
    expect((await post(path, fields, {})).status).toBe(403);
  }
});

test("a command that drafts a project returns the draft", async () => {
  setupImpl = async () => {
    const { action, approval } = draft();
    return { draft: action, approval };
  };
  const r = await post("/api/command", { text: "start a new project called demo" });
  const body = (await r.json()) as { draft: { id: string }; approval: { alwaysAsk: string } };
  expect(body.draft.id).toMatch(/^rpa_/);
  expect(body.approval.alwaysAsk).toBe("create_repo");
});

test("storage lists Atrium's clone and Nakul's own folder, and ask-remove explains a refusal", async () => {
  const { action } = draft();
  await post(`/api/repo-actions/${action.id}/approve`, fields);
  await repos.settle();
  const mine = join(gh.projects, "mine");
  mkdirSync(mine);
  Bun.spawnSync(["git", "init", "-q"], { cwd: mine, env: process.env });
  createSpace(db, { name: "Mine", kind: "repo", goal: "g", repoPath: mine });
  const view = (await (await fetch(`${base}/api/storage`)).json()) as Awaited<ReturnType<Repos["storage"]>>;
  const atrium = view.repos.find((r) => r.spaceName === "demo")!;
  expect(atrium.createdBy).toBe("atrium");
  expect(atrium.bytes).toBeGreaterThan(0);
  expect(atrium.removable).toEqual({ ok: true });
  expect(view.repos.find((r) => r.spaceName === "Mine")).toMatchObject({ createdBy: "you", removable: null, cloneId: null });
  expect(view.atrium.totalBytes).toBeGreaterThanOrEqual(0);
  writeFileSync(join(gh.projects, "demo", "notes.txt"), "mine");
  const r = await post(`/api/clones/${listClones(db)[0]!.id}/ask-remove`);
  expect(r.status).toBe(409);
  expect(await errorOf(r)).toBe("There are files git doesn't track: notes.txt.");
});

test("state lists pending repo drafts with their folder", async () => {
  draft();
  mkdirSync(join(gh.projects, "demo"));
  const state = (await (await fetch(`${base}/api/state`)).json()) as State;
  expect(state.repoActions).toEqual([
    expect.objectContaining({ kind: "create", path: join(gh.projects, "demo"), folderTaken: true, github: null, bytes: null }),
  ]);
});
