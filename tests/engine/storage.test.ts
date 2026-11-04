import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { atriumDiskUsage, enforceTranscriptCap, openTranscript } from "../../src/engine/storage";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;

beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.cleanup());

test("transcript truncates at the per-file cap", () => {
  const t = openTranscript("run_big");
  const chunk = "x".repeat(1024 * 1024) + "\n";
  for (let i = 0; i < 6; i++) t.append(chunk);
  t.close();
  const marker = "[atrium] transcript truncated at 5 MB";
  expect(statSync(t.path).size).toBeLessThanOrEqual(config().transcriptFileCapBytes + marker.length + 1);
  const lines = readFileSync(t.path, "utf8").trimEnd().split("\n");
  expect(lines[lines.length - 1]).toBe(marker);
  expect(lines.filter((l) => l === marker).length).toBe(1);
});

test("cap deletes oldest first", () => {
  const dir = config().transcriptsDir;
  mkdirSync(dir, { recursive: true });
  const names = ["a.log", "b.log", "c.log"];
  names.forEach((n, i) => {
    const p = join(dir, n);
    writeFileSync(p, "y".repeat(1024));
    utimesSync(p, 1000 + i, 1000 + i);
  });
  const { deleted } = enforceTranscriptCap(2048);
  expect(deleted.map((p) => p.split("/").pop())).toEqual(["a.log"]);
  expect(existsSync(join(dir, "a.log"))).toBe(false);
  expect(existsSync(join(dir, "b.log"))).toBe(true);
  expect(existsSync(join(dir, "c.log"))).toBe(true);
});

test("disk usage sums transcripts and db", () => {
  const db = openDb();
  db.close();
  const t = openTranscript("run_usage");
  t.append("hello");
  t.close();
  const u = atriumDiskUsage();
  expect(u.transcriptsBytes).toBe(5);
  expect(u.dbBytes).toBeGreaterThan(0);
  expect(u.totalBytes).toBe(u.transcriptsBytes + u.dbBytes);
});
