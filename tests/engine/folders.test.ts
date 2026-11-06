import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { migrateSpaceFolders, spaceFolder } from "../../src/engine/folders";
import { createSpace, getSpace, updateSpace } from "../../src/engine/spaces";
import { tempHome } from "../helpers";

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

test("general and markets spaces get a folder named after them, de-duplicated", () => {
  const files = config().filesHome;
  mkdirSync(join(files, "notes"), { recursive: true });
  const a = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const b = createSpace(db, { name: "Weekly planning!", kind: "general", goal: "" });
  const c = createSpace(db, { name: "Notes", kind: "general", goal: "" });
  const m = createSpace(db, { name: "Investing", kind: "markets", goal: "" });
  const r = createSpace(db, { name: "Code", kind: "repo", goal: "", repoPath: "/tmp/x" });
  const odd = createSpace(db, { name: "  ✨ ", kind: "general", goal: "" });
  expect(a.folder).toBe(join(files, "weekly-planning"));
  expect(b.folder).toBe(join(files, "weekly-planning-2"));
  expect(c.folder).toBe(join(files, "notes-2"));
  expect(m.folder).toBe(join(files, "investing"));
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
