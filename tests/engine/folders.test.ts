import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { lstatSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { migrateSpaceFolders, spaceFolder } from "../../src/engine/folders";
import { createSpace, getSpace, updateSpace } from "../../src/engine/spaces";
import { tempHome } from "../helpers";

const realRename = fs.renameSync;
let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

test("the visible folder honours ATRIUM_FILES_HOME and never defaults into a test's real home", () => {
  expect(config().filesHome).toBe(process.env.ATRIUM_FILES_HOME!);
  const saved = { h: process.env.ATRIUM_HOME, f: process.env.ATRIUM_FILES_HOME };
  try {
    delete process.env.ATRIUM_FILES_HOME;
    expect(config().filesHome).toBe(join(saved.h!, "files"));
    delete process.env.ATRIUM_HOME;
    expect(config().filesHome).toBe(join(homedir(), "Atrium"));
  } finally {
    process.env.ATRIUM_HOME = saved.h;
    process.env.ATRIUM_FILES_HOME = saved.f;
  }
});

test("general spaces get a folder named after them, de-duplicated", () => {
  const files = config().filesHome;
  mkdirSync(join(files, "notes"), { recursive: true });
  const a = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const b = createSpace(db, { name: "Weekly planning!", kind: "general", goal: "" });
  const c = createSpace(db, { name: "Notes", kind: "general", goal: "" });
  const r = createSpace(db, { name: "Code", kind: "repo", goal: "", repoPath: "/tmp/x" });
  const odd = createSpace(db, { name: "  ✨ ", kind: "general", goal: "" });
  expect(a.folder).toBe(join(files, "weekly-planning"));
  expect(b.folder).toBe(join(files, "weekly-planning-2"));
  expect(c.folder).toBe(join(files, "notes-2"));
  expect(r.folder).toBeNull();
  expect(odd.folder).toBe(join(files, "space"));
  expect(spaceFolder(a)).toBe(a.folder!);
  // Renaming a space doesn't move its folder.
  expect(updateSpace(db, a.id, { name: "Errands" }).folder).toBe(a.folder);
});

test("the migration moves an old hidden space folder into the visible one", () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  // A space from before the move: no folder recorded, its files in Atrium's own data folder.
  db.query("UPDATE spaces SET folder = NULL WHERE id = ?").run(s.id);
  const legacy = join(home.home, "spaces", s.id);
  mkdirSync(join(legacy, "runs", "run_1"), { recursive: true });
  mkdirSync(join(legacy, ".claude", ".cc-writes"), { recursive: true });
  writeFileSync(join(legacy, "grocery-list.md"), "- milk\n");
  writeFileSync(join(legacy, "runs", "run_1", "notes.md"), "kept\n");
  expect(spaceFolder(getSpace(db, s.id)!)).toBe(legacy);
  const fresh = createSpace(db, { name: "Empty", kind: "general", goal: "" });
  db.query("UPDATE spaces SET folder = NULL WHERE id = ?").run(fresh.id);

  const moved = migrateSpaceFolders(db);
  const after = getSpace(db, s.id)!;
  expect(after.folder).toBe(join(config().filesHome, "weekly-planning"));
  expect(readFileSync(join(after.folder!, "grocery-list.md"), "utf8")).toBe("- milk\n");
  expect(readFileSync(join(after.folder!, "runs", "run_1", "notes.md"), "utf8")).toBe("kept\n");
  expect(existsSync(legacy)).toBe(false);
  expect(getSpace(db, fresh.id)!.folder).toBe(join(config().filesHome, "empty"));
  expect(moved).toEqual([{ spaceId: s.id, from: legacy, to: after.folder! }]);
  // Atrium made the visible folder by moving into it, so its identity is recorded for a later delete.
  const st = lstatSync(after.folder!);
  expect(db.query("SELECT folder_dev AS dev, folder_ino AS ino FROM spaces WHERE id = ?").get(s.id)).toEqual({ dev: st.dev, ino: st.ino });
  // Running it again changes nothing.
  expect(migrateSpaceFolders(db)).toEqual([]);
});

test("the migration never moves onto a folder that already exists", () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  db.query("UPDATE spaces SET folder = NULL WHERE id = ?").run(s.id);
  const legacy = join(home.home, "spaces", s.id);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "a.md"), "a");
  mkdirSync(join(config().filesHome, "weekly-planning"), { recursive: true });
  writeFileSync(join(config().filesHome, "weekly-planning", "mine.md"), "mine");
  migrateSpaceFolders(db);
  const after = getSpace(db, s.id)!;
  expect(after.folder).toBe(join(config().filesHome, "weekly-planning-2"));
  expect(readFileSync(join(config().filesHome, "weekly-planning", "mine.md"), "utf8")).toBe("mine");
  expect(readFileSync(join(after.folder!, "a.md"), "utf8")).toBe("a");
});

test("a database from before the move gains the folder column, and boot moves its spaces", () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const r = createSpace(db, { name: "Atrium", kind: "repo", goal: "", repoPath: "/tmp/r" });
  db.exec("ALTER TABLE spaces DROP COLUMN folder");
  db.close();
  const legacy = join(home.home, "spaces", s.id);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "week-of-nov-9.ics"), "BEGIN:VCALENDAR\n");
  db = openDb();
  expect(getSpace(db, s.id)!.folder).toBeNull();
  migrateSpaceFolders(db);
  expect(getSpace(db, s.id)!.folder).toBe(join(config().filesHome, "weekly-planning"));
  expect(getSpace(db, r.id)!.folder).toBeNull();
  expect(existsSync(join(config().filesHome, "weekly-planning", "week-of-nov-9.ics"))).toBe(true);
});

describe("a migration that was interrupted", () => {
  const legacyWith = (id: string, files: Record<string, string>) => {
    const dir = join(home.home, "spaces", id);
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    return dir;
  };

  test("the folder is recorded before the move, and a boot after a hand-made move finds the files, with no -2 folder", () => {
    const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
    db.query("UPDATE spaces SET folder = NULL WHERE id = ?").run(s.id);
    const legacy = legacyWith(s.id, { "grocery-list.md": "- milk\n" });
    // A boot that records the folder and dies before moving anything.
    const target = join(config().filesHome, "weekly-planning");
    const failing = spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("boom"), { code: "EIO" });
    });
    try {
      migrateSpaceFolders(db);
    } finally {
      failing.mockRestore();
    }
    expect(getSpace(db, s.id)!.folder).toBe(target);
    // The files still live in the old folder, so runs keep using it until the move happens.
    expect(spaceFolder(getSpace(db, s.id)!)).toBe(legacy);
    // Nakul (or a half-done rename) moves it by hand; the next boot just uses it.
    fs.renameSync(legacy, target);
    migrateSpaceFolders(db);
    expect(getSpace(db, s.id)!.folder).toBe(target);
    expect(spaceFolder(getSpace(db, s.id)!)).toBe(target);
    expect(readFileSync(join(target, "grocery-list.md"), "utf8")).toBe("- milk\n");
    expect(existsSync(`${target}-2`)).toBe(false);
  });

  test("every boot moves an old folder into a recorded folder that is missing or empty", () => {
    const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
    const target = getSpace(db, s.id)!.folder!;
    mkdirSync(target, { recursive: true });
    legacyWith(s.id, { "a.md": "a" });
    expect(migrateSpaceFolders(db).map((m) => m.to)).toEqual([target]);
    expect(readFileSync(join(target, "a.md"), "utf8")).toBe("a");
    expect(existsSync(join(home.home, "spaces", s.id))).toBe(false);
  });

  test("an old folder is never moved over a recorded folder that has files", () => {
    const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
    const target = getSpace(db, s.id)!.folder!;
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "mine.md"), "mine");
    const legacy = legacyWith(s.id, { "a.md": "a" });
    expect(migrateSpaceFolders(db)).toEqual([]);
    expect(readFileSync(join(target, "mine.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(legacy, "a.md"), "utf8")).toBe("a");
  });

  test("a cross-volume move copies to .partial, marks it .copied, and a boot finishes or redoes it", () => {
    const exdev = () => spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      // Only the legacy-to-target hop crosses volumes; the .partial rename is on the target's volume.
      if (String(to).endsWith(".partial") || String(from).includes(`${sep}spaces${sep}`)) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      return realRename(from, to);
    }) as typeof fs.renameSync);
    const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
    const target = getSpace(db, s.id)!.folder!;
    // A copy that died halfway: the old folder is intact and a stale .partial is left over.
    legacyWith(s.id, { "a.md": "a", "sub/b.md": "b" });
    mkdirSync(`${target}.partial`, { recursive: true });
    writeFileSync(join(`${target}.partial`, "a.md"), "half");
    let spy = exdev();
    try {
      migrateSpaceFolders(db);
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(target, "a.md"), "utf8")).toBe("a");
    expect(readFileSync(join(target, "sub", "b.md"), "utf8")).toBe("b");
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(existsSync(join(home.home, "spaces", s.id))).toBe(false);
    // A copy that was marked complete and removed the old folder, but died before the final rename.
    const t = createSpace(db, { name: "Errands", kind: "general", goal: "" });
    const target2 = getSpace(db, t.id)!.folder!;
    mkdirSync(`${target2}.copied`, { recursive: true });
    writeFileSync(join(`${target2}.copied`, "done.md"), "done");
    spy = exdev();
    try {
      migrateSpaceFolders(db);
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(target2, "done.md"), "utf8")).toBe("done");
    expect(existsSync(`${target2}.copied`)).toBe(false);
  });
});

test("a boot that dies while deleting the old folder after a complete copy loses nothing", () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const target = getSpace(db, s.id)!.folder!;
  const legacy = join(home.home, "spaces", s.id);
  mkdirSync(legacy, { recursive: true });
  for (const n of ["a.md", "b.md", "c.md", "d.md"]) writeFileSync(join(legacy, n), n);
  // The copy finished and was marked complete; the old folder was half deleted when the engine died.
  fs.cpSync(legacy, `${target}.copied`, { recursive: true });
  for (const n of ["a.md", "b.md"]) fs.rmSync(join(legacy, n));
  migrateSpaceFolders(db);
  expect(fs.readdirSync(target).sort()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(`${target}.copied`)).toBe(false);
  expect(spaceFolder(getSpace(db, s.id)!)).toBe(target);
});
