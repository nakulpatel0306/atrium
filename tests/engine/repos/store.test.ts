import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlreadyResolved, getApproval, resolveApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import type { ProjectDraft } from "../../../src/engine/repos/names";
import {
  actionForApproval,
  draftProject,
  getRepoAction,
  listClones,
  markDeclined,
  markRemoved,
  pendingRepoActions,
  presentCloneForPath,
  recordClone,
  setActionStatus,
  touchClone,
  updateDraft,
} from "../../../src/engine/repos/store";
import { tempHome } from "../../helpers";
import { type FakeGitHub, fakeGitHub } from "../../repos-helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let gh: FakeGitHub;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  gh = fakeGitHub();
});
afterEach(() => {
  db.close();
  gh.cleanup();
  home.cleanup();
});

const d: ProjectDraft = { name: "demo", description: "A demo", visibility: "private", template: "bun-ts" };

test("draftProject makes a pending spaceless create_repo approval describing every field", () => {
  const { action, approval } = draftProject(db, d);
  expect(approval.spaceId).toBeNull();
  expect(approval.kind).toBe("question");
  expect(approval.alwaysAsk).toBe("create_repo");
  expect(approval.title).toBe('Create GitHub repo "demo"?');
  for (const line of ["Name: demo", "Visibility: Private", "Description: A demo", "Template: bun + TypeScript", `Local folder: ${join(gh.projects, "demo")}`]) {
    expect(approval.detail).toContain(line);
  }
  expect(approval.detail).toContain("On yes, Atrium creates the repo on your GitHub account with gh");
  expect(action).toMatchObject({ kind: "create", status: "draft", approvalId: approval.id, draft: d });
  expect(actionForApproval(db, approval.id)!.id).toBe(action.id);
  expect(pendingRepoActions(db).map((a) => a.id)).toEqual([action.id]);
});

test("a retry draft says what failed and which repo it reuses", () => {
  const { approval, action } = draftProject(db, d, { remoteUrl: "https://github.com/fakeuser/demo", lastError: "boom" });
  expect(approval.detail.startsWith("Last try failed: boom\nReusing the empty repo https://github.com/fakeuser/demo.")).toBe(true);
  expect(action.remoteUrl).toBe("https://github.com/fakeuser/demo");
});

test("the detail warns when the folder is already taken", () => {
  mkdirSync(join(gh.projects, "Demo"));
  expect(draftProject(db, d).approval.detail).toContain('A folder named "Demo" already exists');
});

test("updateDraft rewrites the approval while pending, and refuses after", () => {
  const { action, approval } = draftProject(db, d);
  const next = updateDraft(db, action.id, { ...d, name: "other" });
  expect(next.draft!.name).toBe("other");
  expect(getApproval(db, approval.id)!.title).toBe('Create GitHub repo "other"?');
  resolveApproval(db, approval.id, "reject");
  expect(() => updateDraft(db, action.id, d)).toThrow(AlreadyResolved);
});

test("only legal status moves are allowed", () => {
  const { action } = draftProject(db, d);
  expect(() => setActionStatus(db, action.id, "done")).toThrow();
  setActionStatus(db, action.id, "running");
  expect(() => setActionStatus(db, action.id, "draft")).toThrow();
  expect(() => setActionStatus(db, action.id, "rejected")).toThrow();
  const done = setActionStatus(db, action.id, "done", { spaceId: null, error: null });
  expect(done.status).toBe("done");
  expect(() => setActionStatus(db, action.id, "failed")).toThrow();
  expect(getRepoAction(db, action.id)!.status).toBe("done");
});

test("clones are recorded with their .git identity", () => {
  const path = join(gh.projects, "demo");
  mkdirSync(join(path, ".git"), { recursive: true });
  const c = recordClone(db, { spaceId: null, path, github: "fakeuser/demo", origin: "clone" });
  expect(c.status).toBe("present");
  expect(presentCloneForPath(db, path)!.id).toBe(c.id);
  touchClone(db, path, 5);
  expect(listClones(db)[0]!.lastUsedAt).toBe(5);
  markDeclined(db, c.id, 6);
  expect(listClones(db)[0]!.declinedAt).toBe(6);
  markRemoved(db, c.id, 7);
  expect(listClones(db)[0]).toMatchObject({ status: "removed", removedAt: 7 });
  expect(presentCloneForPath(db, path)).toBeNull();
});

test("recordClone refuses a folder whose .git is a file", () => {
  const path = join(gh.projects, "wt");
  mkdirSync(path);
  writeFileSync(join(path, ".git"), "gitdir: /elsewhere\n");
  expect(() => recordClone(db, { spaceId: null, path, github: "fakeuser/wt", origin: "clone" })).toThrow();
});
