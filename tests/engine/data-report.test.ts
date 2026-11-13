import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataLocations, formatBytes, formatData } from "../../src/engine/data-report";
import { openDb } from "../../src/engine/db";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
beforeEach(() => void (home = tempHome()));
afterEach(() => home.cleanup());

test("atrium data lists the database, transcripts, space files with sizes", () => {
  const before = Object.fromEntries(dataLocations().map((l) => [l.label, l.bytes]));
  expect(before.Database).toBeNull();
  openDb().close();
  mkdirSync(join(home.home, "files", "notes"), { recursive: true });
  writeFileSync(join(home.home, "files", "notes", "a.md"), "x".repeat(2048));
  const locs = dataLocations();
  expect(locs.map((l) => l.label)).toEqual(["Database", "Transcripts", "Space files"]);
  expect(locs[0]!.bytes).toBeGreaterThan(0);
  expect(locs[2]!.bytes).toBe(2048);
  const text = formatData(locs);
  expect(text).toContain("atrium.db");
  expect(text).toContain("2.0 KB");
  expect(text).toContain("atrium uninstall");
  expect(formatBytes(null)).toBe("not created yet");
});
