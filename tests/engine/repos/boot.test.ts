import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getApproval, listPending, reopenDecision, resolveApproval } from "../../../src/engine/approvals";
import { bootRepos } from "../../../src/engine/boot";
import { openDb } from "../../../src/engine/db";
import { askToRemove } from "../../../src/engine/repos/cleanup";
import { createCloner } from "../../../src/engine/repos/clones";
import { createRepos } from "../../../src/engine/repos";
import type { ProjectDraft } from "../../../src/engine/repos/names";
import { actionForApproval, draftProject, getRepoAction, listClones } from "../../../src/engine/repos/store";
import { createSpace } from "../../../src/engine/spaces";
import { tempHome } from "../../helpers";
import { type FakeGitHub, fakeGitHub, seedRemote } from "../../repos-helpers";

// Each case runs git and the fake gh several times.
setDefaultTimeout(30_000);

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

const draft: ProjectDraft = { name: "demo", description: "A demo project.", visibility: "private", template: "bun-ts" };
// As if the engine stopped during the hold and came back two minutes later.
const backdate = (id: string) => db.query("UPDATE approvals SET resolved_at = ? WHERE id = ?").run(Date.now() - 120_000, id);

test("a new repo whose hold ran out while the engine was down waits a fresh minute after boot, then is made once", async () => {
  const { action, approval } = draftProject(db, draft);
  resolveApproval(db, approval.id, "approve");
  backdate(approval.id);
  // Boot order as main.ts: the engine side is built, then recovery, then held yeses resume.
  const repos = createRepos({ db, kick: () => {}, holdMs: 150 });
  bootRepos(db, repos);
  await repos.settle();
  // Nothing ran yet: a fresh minute, so it can still be taken back.
  expect(getRepoAction(db, action.id)!.status).toBe("draft");
  expect(Date.now() - getApproval(db, approval.id)!.resolvedAt!).toBeLessThan(5_000);
  await Bun.sleep(300);
  await repos.settle();
  const done = getRepoAction(db, action.id)!;
  expect(done.status).toBe("done");
  expect(done.error).toBeNull();
  expect(listPending(db).filter((a) => a.alwaysAsk === "create_repo")).toHaveLength(0);
  expect(existsSync(join(gh.remotes, "fakeuser", "demo.git"))).toBe(true);
});

test("a held new repo can be taken back in its fresh minute after boot, and nothing is made", async () => {
  const { action, approval } = draftProject(db, draft);
  resolveApproval(db, approval.id, "approve");
  backdate(approval.id);
  const repos = createRepos({ db, kick: () => {}, holdMs: 150 });
  bootRepos(db, repos);
  const again = reopenDecision(db, approval.id);
  await Bun.sleep(300);
  await repos.settle();
  expect(getRepoAction(db, action.id)!.status).toBe("draft");
  expect(listPending(db).map((a) => a.id)).toContain(again.id);
  expect(existsSync(join(gh.remotes, "fakeuser", "demo.git"))).toBe(false);
});

test("a removal whose hold ran out while the engine was down removes the copy once and says so", async () => {
  seedRemote(gh, "demo", { ".gitignore": ".env\n" });
  const space = createSpace(db, { name: "Demo", kind: "repo", goal: "g", github: "fakeuser/demo" });
  const cloner = createCloner(db, () => {});
  cloner.request(space);
  await cloner.settle();
  const clone = listClones(db)[0]!;
  const asked = await askToRemove(db, clone.id);
  if (!("approval" in asked)) throw new Error(asked.reasons.join(" "));
  resolveApproval(db, asked.approval.id, "approve");
  backdate(asked.approval.id);
  const repos = createRepos({ db, kick: () => {}, holdMs: 150 });
  bootRepos(db, repos);
  await repos.settle();
  expect(existsSync(clone.path)).toBe(true);
  await Bun.sleep(300);
  await repos.settle();
  const action = actionForApproval(db, asked.approval.id)!;
  expect(action.status).toBe("done");
  expect(action.error).toBeNull();
  expect(existsSync(clone.path)).toBe(false);
  expect(listClones(db)[0]!.status).toBe("removed");
});
