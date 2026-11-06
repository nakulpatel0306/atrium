import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFile } from "../../../src/engine/outputs/open";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let dir: string;
let log: string;
beforeEach(() => {
  home = tempHome();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "atrium-open-")));
  log = join(dir, "open.log");
  process.env.FAKE_OPEN_LOG = log;
});
afterEach(() => {
  delete process.env.FAKE_OPEN_LOG;
  delete process.env.FAKE_OPEN_EXIT;
  home.cleanup();
  rmSync(dir, { recursive: true, force: true });
});
const file = (name: string, mode = 0o644) => {
  const p = join(dir, name);
  writeFileSync(p, "x");
  chmodSync(p, mode);
  return p;
};
const logged = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("tempHome points open at the fake", () => {
  expect(process.env.ATRIUM_OPEN_BIN).toEndWith("tests/fixtures/fake-open.ts");
});

test("open, reveal and calendar pass one path to open", async () => {
  const list = file("list.md");
  const cmd = file("run.command", 0o755);
  const week = file("week.ics");
  await openFile(list, "open");
  await openFile(cmd, "reveal");
  await openFile(week, "calendar");
  expect(logged()).toEqual([[list], ["-R", cmd], ["-a", "Calendar", week]]);
});

test("open refuses anything that could run code", async () => {
  const msg = "Atrium won't open this kind of file directly, since it could run code. Use Reveal in Finder to look at it.";
  mkdirSync(join(dir, "Thing.app"));
  for (const p of [file("run.command"), file("tool.sh"), file("page.html"), join(dir, "Thing.app"), file("notes.md", 0o755)]) {
    await expect(openFile(p, "open")).rejects.toThrow(msg);
  }
  await expect(openFile(file("list.md"), "calendar")).rejects.toThrow("Only .ics files can be added to Calendar.");
  expect(logged()).toEqual([]);
});

test("odd names stay one argument", async () => {
  const a = file("-rf.md");
  const b = file("a b ü.md");
  await openFile(a, "open");
  await openFile(b, "open");
  const l = logged();
  expect(l).toEqual([[a], [b]]);
  for (const args of l) expect(args[0].startsWith("/")).toBe(true);
});

test("a failed open says what to do", async () => {
  process.env.FAKE_OPEN_EXIT = "1";
  await expect(openFile(file("list.md"), "open")).rejects.toThrow("macOS couldn't open list.md. Use Reveal in Finder and open it from there.");
});
