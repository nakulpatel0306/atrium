// The review's repros for Plan 13 (R1–R5), kept as tests: each asserts the safe behaviour.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { deleteSpace, deleteTask, spaceDeletePreview, taskDeletePreview } from "../../src/engine/delete";
import { finishPendingDeletes, queueDelete } from "../../src/engine/delete-files";
import { ensureSpaceFolder } from "../../src/engine/folders";
import { newId } from "../../src/engine/ids";
import { recordRunFiles } from "../../src/engine/outputs/store";
import { createCloner } from "../../src/engine/repos/clones";
import { listClones } from "../../src/engine/repos/store";
import { createSpace, getSpace, updateSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../../src/engine/tasks";
import { messagesSpace, mergeRestoredMessages, messagesMergeWait } from "../../src/engine/messaging/space";
import { tildePath } from "../../src/engine/folders";
import { draftMessage } from "../../src/engine/messaging/store";
import { autoLookup } from "../../src/engine/messaging/contacts";
import { setSetting } from "../../src/engine/settings";
import { tempHome } from "../helpers";
import { fakeGitHub, seedRemote } from "../repos-helpers";

setDefaultTimeout(30_000);
let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  delete process.env.ATRIUM_TRASH;
  db.close();
  home.cleanup();
});

function finishedTaskThatMade(spaceId: string, file: string, body: string) {
  const task = createTask(db, { spaceId, title: "Write notes" }).id;
  const run = newId("run");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, ended_at, exit_code, transcript_path) VALUES (?, ?, 'claude', 0, 1, 0, '/nonexistent.log')").run(run, task);
  recordRunFiles(db, { runId: run, taskId: task, spaceId, root: "space" }, [{ path: file, change: "created", size: body.length }]);
  setTaskStatus(db, task, "running");
  setTaskStatus(db, task, "done");
  return task;
}

// R1: deleting a task removes a file it made even after Nakul edited it by hand (size no longer matches the record).
test("R1 deleteTask keeps a made file that was edited since the run", async () => {
  const space = createSpace(db, { name: "Notes", kind: "general", goal: "g" });
  mkdirSync(space.folder!, { recursive: true });
  writeFileSync(join(space.folder!, "notes.md"), "draft");
  const task = finishedTaskThatMade(space.id, "notes.md", "draft");
  writeFileSync(join(space.folder!, "notes.md"), "draft\n\nTwo weeks of my own notes I typed in by hand.");
  await deleteTask(db, task);
  expect(existsSync(join(space.folder!, "notes.md"))).toBe(true);
});

// R2: deleting a finished task while another task in the same space is running (and editing the file) removes it.
test("R2 deleteTask doesn't remove a file while another task in the space is running", async () => {
  const space = createSpace(db, { name: "Notes", kind: "general", goal: "g" });
  mkdirSync(space.folder!, { recursive: true });
  writeFileSync(join(space.folder!, "report.md"), "v1");
  const old = finishedTaskThatMade(space.id, "report.md", "v1");
  const live = createTask(db, { spaceId: space.id, title: "Improve the report" }).id;
  setTaskStatus(db, live, "running");
  writeFileSync(join(space.folder!, "report.md"), "v2, the running agent's edit");
  let refused = false;
  try {
    await deleteTask(db, old);
  } catch {
    refused = true;
  }
  expect(refused || existsSync(join(space.folder!, "report.md"))).toBe(true);
});

// R3: deleting a repo space while its clone is still downloading. The clone lands, recordClone hits the FK, the
// .catch's own logActivity hits it too, and the job rejects: in the engine that is an unhandled rejection (bun exits).
test("R3 deleting a repo space mid-clone doesn't reject the clone job or leave an unrecorded clone", async () => {
  const gh = fakeGitHub();
  try {
    seedRemote(gh, "proj");
    const space = createSpace(db, { name: "proj", kind: "repo", goal: "g", github: "fakeuser/proj" });
    const cloner = createCloner(db, () => {});
    cloner.request(space);
    await deleteSpace(db, space.id, "proj");
    expect(getSpace(db, space.id)).toBeNull();
    let error: unknown = null;
    await cloner.settle().catch((e: unknown) => (error = e));
    expect(String(error)).toBe("null");
    const dest = join(process.env.ATRIUM_PROJECTS_ROOT!, "proj");
    // Either no folder, or a folder Atrium still knows is its own.
    expect(!existsSync(dest) || listClones(db).some((c: { path: string }) => c.path === dest)).toBe(true);
  } finally {
    gh.cleanup();
  }
});

// R4: a Contacts lookup in flight when the task's space is deleted: the catch's logActivity hits the FK and
// autoLookup rejects; the runner calls it with `void`, so in the engine this is an unhandled rejection.
test("R4 autoLookup doesn't reject when its draft's space is deleted mid-lookup", async () => {
  process.env.FAKE_OSASCRIPT_CONTACTS = "[]";
  const space = createSpace(db, { name: "Text Sam", kind: "general", goal: "g" });
  const task = createTask(db, { spaceId: space.id, title: "Text Sam" }).id;
  setTaskStatus(db, task, "running");
  setTaskStatus(db, task, "review");
  const { action } = draftMessage(db, { spaceId: space.id, taskId: task, toName: "Sam", text: "Hi" });
  setSetting(db, "messaging.contactsReady", "true");
  const pending = autoLookup(db, action.id);
  await deleteSpace(db, space.id, "Text Sam");
  let error: unknown = null;
  await pending.catch((e: unknown) => (error = e));
  expect(String(error)).toBe("null");
});

// R5 (control, passes): the folder removal never leaves its root, even for a recorded ".." or the root itself.
test("R5 control: a recorded folder equal to the files home or its parent is refused", async () => {
  const space = createSpace(db, { name: "Odd", kind: "general", goal: "g" });
  const root = process.env.ATRIUM_FILES_HOME!;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "keep.txt"), "x");
  db.query("UPDATE spaces SET folder = ? WHERE id = ?").run(root + "/", space.id);
  await deleteSpace(db, space.id, "Odd");
  expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("x");
});

test("a repo space is refused while its clone is downloading", async () => {
  const space = createSpace(db, { name: "proj", kind: "repo", goal: "g", github: "fakeuser/proj" });
  const guards = { cloning: (id: string) => id === space.id };
  expect(spaceDeletePreview(db, space.id, guards).refusal).toBe("Atrium is still getting a local copy of this repo. Try again in a minute. Nothing was deleted.");
  const err = await deleteSpace(db, space.id, "proj", guards).catch((e) => e);
  expect(err.status).toBe(409);
  expect(getSpace(db, space.id)).not.toBeNull();
});

test("an empty typed name never deletes, even a space whose name trims to nothing", async () => {
  const space = createSpace(db, { name: " ", kind: "general", goal: "g" });
  const err = await deleteSpace(db, space.id, "").catch((e) => e);
  expect(err.status).toBe(400);
  expect(getSpace(db, space.id)).not.toBeNull();
});

test("task delete names its files, and keeps one edited between the confirm and the removal", async () => {
  const space = createSpace(db, { name: "Notes", kind: "general", goal: "g" });
  mkdirSync(space.folder!, { recursive: true });
  writeFileSync(join(space.folder!, "notes.md"), "draft");
  writeFileSync(join(space.folder!, "edited.md"), "draft");
  const task = finishedTaskThatMade(space.id, "notes.md", "draft");
  const run = (db.query("SELECT id FROM runs WHERE task_id = ?").get(task) as { id: string }).id;
  recordRunFiles(db, { runId: run, taskId: task, spaceId: space.id, root: "space" }, [{ path: "edited.md", change: "created", size: 5 }]);
  // Touched later, same size: the modified time says it's no longer as the run left it.
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(space.folder!, "edited.md"), later, later);
  expect(taskDeletePreview(db, task)).toMatchObject({ files: ["notes.md"], edited: ["edited.md"] });
  const { kept } = await deleteTask(db, task);
  expect(kept).toContain("Kept edited.md: it changed after the task made it.");
  expect(existsSync(join(space.folder!, "notes.md"))).toBe(false);
  expect(readFileSync(join(space.folder!, "edited.md"), "utf8")).toBe("draft");
});

test("a queued file removal re-checks the file on boot and keeps one changed since", async () => {
  const root = join(config().filesHome, "notes");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.md"), "abc");
  queueDelete(db, "file", "a.md", root, { size: 3, mtimeMax: Date.now() + 2000 });
  writeFileSync(join(root, "a.md"), "Nakul's own words now");
  await finishPendingDeletes(db);
  expect(readFileSync(join(root, "a.md"), "utf8")).toBe("Nakul's own words now");
  expect(db.query("SELECT COUNT(*) AS n FROM pending_deletes").get()).toEqual({ n: 0 });
});

test("a deleted space's folder goes to the Trash, and leftover trash is cleared first", async () => {
  const space = createSpace(db, { name: "Reading", kind: "general", goal: "g" });
  ensureSpaceFolder(db, space);
  writeFileSync(join(space.folder!, "list.md"), "books");
  await deleteSpace(db, space.id, "Reading");
  expect(existsSync(space.folder!)).toBe(false);
  const trash = join(config().home, "trash");
  const moved = readdirSync(trash).find((n) => n.startsWith("reading (deleted "));
  expect(moved).toBeDefined();
  expect(readFileSync(join(trash, moved!, "list.md"), "utf8")).toBe("books");

  // An earlier try's half-removed copy is cleared even when the folder's name has been taken again since.
  const leftover = join(config().filesHome, ".atrium-trash-del_old");
  mkdirSync(leftover, { recursive: true });
  const again = createSpace(db, { name: "Reading", kind: "general", goal: "g" });
  db.transaction(() => queueDelete(db, "folder", again.folder!, config().filesHome))();
  db.query("UPDATE pending_deletes SET id = 'del_old'").run();
  await finishPendingDeletes(db);
  expect(existsSync(leftover)).toBe(false);
});

test("a files home that is the home folder is never cleared out", async () => {
  const fakeHome = join(config().home, "me");
  mkdirSync(join(fakeHome, "projects"), { recursive: true });
  writeFileSync(join(fakeHome, "projects", "mine.txt"), "mine");
  const saved = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    db.transaction(() => queueDelete(db, "folder", join(fakeHome, "projects"), fakeHome))();
    const done = await finishPendingDeletes(db);
    expect(done[0]!.note).toContain("its files folder is your home folder");
    expect(lstatSync(join(fakeHome, "projects", "mine.txt")).isFile()).toBe(true);
  } finally {
    process.env.HOME = saved;
  }
});

// W1 (second review): when the Trash can't take the folder, it stays, and the result says so plainly.
test("W1 a folder that couldn't go to the Trash stays where it is, and the result says so", async () => {
  const blocker = join(home.home, "not-a-dir");
  writeFileSync(blocker, "x");
  process.env.ATRIUM_TRASH = join(blocker, "trash");
  const space = createSpace(db, { name: "Notes", kind: "general", goal: "g" });
  ensureSpaceFolder(db, space);
  writeFileSync(join(space.folder!, "mine.md"), "my own notes");
  const res = await deleteSpace(db, space.id, "Notes");
  expect(readFileSync(join(space.folder!, "mine.md"), "utf8")).toBe("my own notes");
  expect(res.message).toBe(`Deleted "Notes". Atrium couldn't move ${tildePath(space.folder!)} to the Trash, so it's still there; delete it in Finder if you don't need it.`);
  expect(getSpace(db, space.id)).toBeNull();
});

test("the result says where the folder went", async () => {
  const space = createSpace(db, { name: "Notes", kind: "general", goal: "g" });
  ensureSpaceFolder(db, space);
  const res = await deleteSpace(db, space.id, "Notes");
  expect(res.message).toBe(`Deleted "Notes". Its folder ${tildePath(space.folder!)} went to the Trash.`);
});

test("a folder Atrium never made, or one swapped in since, is left alone", async () => {
  const never = createSpace(db, { name: "Never ran", kind: "general", goal: "g" });
  mkdirSync(never.folder!, { recursive: true });
  writeFileSync(join(never.folder!, "mine.md"), "Nakul made this folder himself");
  expect((await deleteSpace(db, never.id, "Never ran")).message).toBe(`Deleted "Never ran". Atrium never made ${tildePath(never.folder!)}, so it left it where it is.`);
  expect(existsSync(join(never.folder!, "mine.md"))).toBe(true);

  const swapped = createSpace(db, { name: "Swapped", kind: "general", goal: "g" });
  ensureSpaceFolder(db, swapped);
  const { rmSync: rm } = await import("node:fs");
  rm(swapped.folder!, { recursive: true });
  mkdirSync(swapped.folder!);
  writeFileSync(join(swapped.folder!, "other.md"), "a different folder now");
  expect((await deleteSpace(db, swapped.id, "Swapped")).message).toContain("it isn't the folder Atrium made for this space");
  expect(existsSync(join(swapped.folder!, "other.md"))).toBe(true);
});

// W2 (second review): a Messages merge waits while a task in the old space is running.
test("W2 a Messages merge waits while a task in the old space is running", () => {
  const old = messagesSpace(db);
  const task = createTask(db, { spaceId: old.id, title: "Draft a text to Sam" }).id;
  setTaskStatus(db, task, "running");
  updateSpace(db, old.id, { status: "archived" });
  messagesSpace(db);
  expect(messagesMergeWait(db, old.id)).toBe("A text is still being drafted in the earlier Messages space. Try again once it's done.");
  const merged = mergeRestoredMessages(db, old.id);
  expect(merged === null && getSpace(db, old.id) !== null && getTask(db, task)?.spaceId === old.id).toBe(true);
});
