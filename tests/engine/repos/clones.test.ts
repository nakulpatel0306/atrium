import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/engine/db";
import { listActivity } from "../../../src/engine/events";
import { createCloner } from "../../../src/engine/repos/clones";
import { listClones } from "../../../src/engine/repos/store";
import { createSpace, getSpace } from "../../../src/engine/spaces";
import { createTask, getTask } from "../../../src/engine/tasks";
import { tempHome } from "../../helpers";
import { type FakeGitHub, fakeGitHub, seedRemote } from "../../repos-helpers";

// Each test spawns git, the fake gh and sometimes ssh-keygen several times; slow under load.
setDefaultTimeout(30_000);

let home: ReturnType<typeof tempHome>;
let db: Database;
let gh: FakeGitHub;
let kicks: number;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  gh = fakeGitHub();
  kicks = 0;
});
afterEach(() => {
  db.close();
  gh.cleanup();
  home.cleanup();
});

const attached = () => createSpace(db, { name: "Demo", kind: "repo", goal: "g", github: "fakeuser/demo" });
const cloner = () => createCloner(db, () => void kicks++);

test("a requested clone lands in the projects root and is recorded as Atrium's", async () => {
  seedRemote(gh, "demo");
  const s = attached();
  const c = cloner();
  c.request(s);
  expect(c.pending(s.id)).toBe(true);
  c.request(s);
  await c.settle();
  expect(c.pending(s.id)).toBe(false);
  const dest = join(gh.projects, "demo");
  expect(existsSync(join(dest, "README.md"))).toBe(true);
  expect(getSpace(db, s.id)!.repoPath).toBe(dest);
  expect(listClones(db)).toMatchObject([{ origin: "clone", path: dest, github: "fakeuser/demo", spaceId: s.id }]);
  expect(listActivity(db).filter((a) => a.message.startsWith("Cloned fakeuser/demo into"))).toHaveLength(1);
  expect(kicks).toBe(1);
});

test("an unrelated folder with that name blocks the space's tasks and is left alone", async () => {
  seedRemote(gh, "demo");
  const s = attached();
  const t = createTask(db, { spaceId: s.id, title: "Read" });
  mkdirSync(join(gh.projects, "demo"));
  const c = cloner();
  c.request(s);
  await c.settle();
  expect(getTask(db, t.id)!.status).toBe("blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe(
    `A folder named "demo" already exists in ${gh.projects} and isn't fakeuser/demo. Rename or move it, then retry the task.`,
  );
  expect(readdirSync(join(gh.projects, "demo"))).toEqual([]);
  expect(listClones(db)).toEqual([]);
});

test("a checkout of the same repo is used as Nakul's own folder", async () => {
  seedRemote(gh, "demo");
  const r = Bun.spawnSync(["git", "clone", "-q", "https://github.com/fakeuser/demo.git", join(gh.projects, "demo")], { env: process.env });
  expect(r.exitCode).toBe(0);
  const s = attached();
  const c = cloner();
  c.request(s);
  await c.settle();
  expect(getSpace(db, s.id)!.repoPath).toBe(join(gh.projects, "demo"));
  expect(listClones(db)).toEqual([]);
});

test("a clone that fails blocks the tasks with gh's plain message and leaves no folder", async () => {
  const s = attached();
  const t = createTask(db, { spaceId: s.id, title: "Read" });
  const c = cloner();
  c.request(s);
  await c.settle();
  expect(getTask(db, t.id)!.status).toBe("blocked");
  expect(getTask(db, t.id)!.blockedReason).toMatch(/^(GitHub said|Couldn't)/);
  expect(existsSync(join(gh.projects, "demo"))).toBe(false);
  expect(listClones(db)).toEqual([]);
});

test("a deleted clone is cloned again", async () => {
  seedRemote(gh, "demo");
  const s = attached();
  const c = cloner();
  c.request(s);
  await c.settle();
  rmSync(join(gh.projects, "demo"), { recursive: true, force: true });
  db.exec("UPDATE repo_clones SET status = 'removed'");
  c.request(getSpace(db, s.id)!);
  await c.settle();
  expect(existsSync(join(gh.projects, "demo", "README.md"))).toBe(true);
  expect(listClones(db).filter((x) => x.status === "present")).toHaveLength(1);
});

test("two spaces on the same repo share one clone", async () => {
  seedRemote(gh, "demo");
  const a = attached();
  const b = createSpace(db, { name: "Demo 2", kind: "repo", goal: "g", github: "fakeuser/demo" });
  const c = cloner();
  c.request(a);
  c.request(b);
  expect(c.pending(b.id)).toBe(true);
  await c.settle();
  c.request(getSpace(db, b.id)!);
  await c.settle();
  expect(listClones(db)).toHaveLength(1);
  expect(listActivity(db).filter((x) => x.message.startsWith("Cloned "))).toHaveLength(1);
  expect(getSpace(db, a.id)!.repoPath).toBe(join(gh.projects, "demo"));
  expect(getSpace(db, b.id)!.repoPath).toBe(join(gh.projects, "demo"));
});

test("two repos with the same name never clobber each other", async () => {
  seedRemote(gh, "utils", {}, "alice");
  seedRemote(gh, "utils", {}, "bob");
  const alice = createSpace(db, { name: "Alice", kind: "repo", goal: "g", github: "alice/utils" });
  const bob = createSpace(db, { name: "Bob", kind: "repo", goal: "g", github: "bob/utils" });
  const t = createTask(db, { spaceId: bob.id, title: "Read" });
  const c = cloner();
  c.request(alice);
  c.request(bob);
  await c.settle();
  c.request(getSpace(db, bob.id)!);
  await c.settle();
  const dest = join(gh.projects, "utils");
  expect(existsSync(join(dest, "README.md"))).toBe(true);
  expect(Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], { cwd: dest, env: process.env }).stdout.toString().trim()).toBe(
    "https://github.com/alice/utils.git",
  );
  expect(getTask(db, t.id)!.blockedReason).toBe(
    `A folder named "utils" already exists in ${gh.projects} and isn't bob/utils. Rename or move it, then retry the task.`,
  );
  expect(getSpace(db, bob.id)!.repoPath).toBeNull();
});
