import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefing } from "../../src/engine/briefing";
import { config, setChosenProjectsRoot } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { applyProjectsRoot, migrateProjectsRoot, PROJECTS_KEY, setProjectsRoot, setUserName, suggestedName } from "../../src/engine/profile";
import { getSetting, setSetting } from "../../src/engine/settings";
import { createSpace, listSpaces } from "../../src/engine/spaces";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  setChosenProjectsRoot(null);
  home.cleanup();
});

test("a fresh engine on an empty home has no spaces, holdings or names", () => {
  expect(listSpaces(db, { includeArchived: true })).toHaveLength(0);
  // Nothing in settings is a name or a path of anyone's.
  const settings = db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  expect(settings.filter((s) => /name|root/i.test(s.key))).toEqual([]);
  expect(briefing(db, Date.parse("2026-11-04T09:00:00")).greeting).toBe("Good morning.");
  setUserName(db, "Sam Rivera");
  expect(briefing(db, Date.parse("2026-11-04T09:00:00")).greeting).toBe("Good morning, Sam.");
});

test("the projects folder defaults to ~/Developer or ~/Projects, and a Settings value or the environment overrides it", () => {
  expect(config().projectsRoot).toMatch(/\/(Developer|Projects)$/);
  process.env.ATRIUM_USER_HOME = home.home;
  const chosen = join(home.home, "code");
  expect(setProjectsRoot(db, chosen)).toBe(chosen);
  expect(config().projectsRoot).toBe(chosen);
  process.env.ATRIUM_PROJECTS_ROOT = join(home.home, "env");
  expect(config().projectsRoot).toBe(join(home.home, "env"));
  delete process.env.ATRIUM_PROJECTS_ROOT;
  expect(() => setProjectsRoot(db, "relative/dir")).toThrow("Give a folder path");
  expect(() => setProjectsRoot(db, "/etc/projects")).toThrow("Pick a folder inside your home folder");
  expect(() => setProjectsRoot(db, home.home)).toThrow("Pick a folder inside your home folder");
  const locked = join(home.home, "locked");
  mkdirSync(locked, { mode: 0o500 });
  expect(() => setProjectsRoot(db, join(locked, "sub"))).toThrow("can't write to that folder");
  delete process.env.ATRIUM_USER_HOME;
});

// A copy of a database shaped like a long-time install: spaces already inside the old default folder.
test("the old default folder is kept once, additively, only when spaces already live in it", () => {
  const legacy = mkdtempSync(join(tmpdir(), "atrium-legacy-"));
  try {
    mkdirSync(join(legacy, "app"));
    const notes = createSpace(db, { name: "Notes", kind: "general", goal: "g", private: true });
    expect(migrateProjectsRoot(db, legacy)).toBe(false);
    expect(getSetting(db, PROJECTS_KEY)).toBeNull();
    createSpace(db, { name: "App", kind: "repo", goal: "g", repoPath: join(legacy, "app") });
    expect(migrateProjectsRoot(db, legacy)).toBe(true);
    expect(getSetting(db, PROJECTS_KEY)).toBe(legacy);
    applyProjectsRoot(db);
    expect(config().projectsRoot).toBe(legacy);
    // Run again, or after the user chose another folder: nothing changes.
    expect(migrateProjectsRoot(db, legacy)).toBe(false);
    setSetting(db, PROJECTS_KEY, "/somewhere/else");
    expect(migrateProjectsRoot(db, legacy)).toBe(false);
    expect(getSetting(db, PROJECTS_KEY)).toBe("/somewhere/else");
    // The existing spaces are untouched.
    expect(listSpaces(db).map((s) => s.name).sort()).toEqual(["App", "Notes"]);
    expect(listSpaces(db).find((s) => s.id === notes.id)).toBeTruthy();
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});

test("the old folder is also kept when it holds a git checkout, even with no space pointing into it", () => {
  const legacy = mkdtempSync(join(tmpdir(), "atrium-legacy-"));
  try {
    mkdirSync(join(legacy, "notes-only"));
    expect(migrateProjectsRoot(db, legacy)).toBe(false);
    mkdirSync(join(legacy, "app", ".git"), { recursive: true });
    expect(migrateProjectsRoot(db, legacy)).toBe(true);
    expect(getSetting(db, PROJECTS_KEY)).toBe(legacy);
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});

test("generic Mac account names give no name, any case", () => {
  for (const n of ["Admin", "administrator", "ROOT", "User Account", "Guest", "mac Mini"]) {
    process.env.ATRIUM_MAC_NAME = n;
    expect(suggestedName()).toBeNull();
  }
  process.env.ATRIUM_MAC_NAME = "Priya Patel";
  expect(suggestedName()).toBe("Priya");
  process.env.ATRIUM_MAC_NAME = "";
});
