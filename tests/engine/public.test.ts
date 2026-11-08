import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefing } from "../../src/engine/briefing";
import { config, setChosenProjectsRoot } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { addAccount, accountChoices } from "../../src/engine/money/accounts";
import { importMoney, previewMoney } from "../../src/engine/money/import";
import { listHoldings } from "../../src/engine/markets/holdings";
import { knownAccounts } from "../../src/engine/money/imports";
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

test("a fresh engine on an empty home has no spaces, holdings, accounts or names", () => {
  expect(listSpaces(db, { includeArchived: true })).toHaveLength(0);
  expect(db.query("SELECT COUNT(*) AS n FROM market_holdings").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM money_accounts").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM money_transactions").get()).toEqual({ n: 0 });
  expect(accountChoices(db, "none", null)).toEqual(["Imported"]);
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
    const investing = createSpace(db, { name: "Investing", kind: "markets", goal: "g", private: true });
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
    expect(listSpaces(db).map((s) => s.name).sort()).toEqual(["App", "Investing"]);
    expect(listSpaces(db).find((s) => s.id === investing.id)).toBeTruthy();
    expect(listHoldings(db, investing.id)).toEqual([]);
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

test("moving an import can target an account that only an import record names", () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g", private: true });
  db.query("INSERT INTO money_imports (id, space_id, account, first_date, last_date, rows, imported_at) VALUES ('mi_x', ?, 'Old card', 'd', 'd', 0, 1)").run(space.id);
  expect(knownAccounts(db, space.id)).toEqual(["Old card"]);
});

test("accounts an existing install already imported still appear in the picker", () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g", private: true });
  const csv = readFileSync(join(import.meta.dir, "..", "fixtures", "money", "td-chequing.csv"), "utf8");
  importMoney(db, space.id, previewMoney(csv, { account: "TD chequing" }));
  expect(accountChoices(db, space.id, null)).toEqual(["TD chequing", "Imported"]);
});

test("accounts: the picker offers imported and added accounts, the format's suggestion and the catch-all", () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g", private: true });
  expect(accountChoices(db, space.id, "TD chequing")).toEqual(["TD chequing", "Imported"]);
  expect(addAccount(db, space.id, { name: "Everyday", kind: "chequing", institution: "Example Bank" })).toBe("Everyday");
  expect(accountChoices(db, space.id, "TD chequing")).toEqual(["Everyday", "TD chequing", "Imported"]);
  expect(() => addAccount(db, space.id, { name: " ", kind: "chequing" })).toThrow("Give the account a name");
  expect(() => addAccount(db, space.id, { name: "X", kind: "brokerage" })).toThrow("Pick chequing, savings or credit card");
  // A card number typed as a name is masked.
  expect(addAccount(db, space.id, { name: "Card 4111111111111111", kind: "credit card" })).not.toContain("4111111111111111");
});
