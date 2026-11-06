import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../../src/engine/config";
import { resolveTarget } from "../../../src/engine/outputs/files";
import { openFile } from "../../../src/engine/outputs/open";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let dir: string;
let log: string;
beforeEach(() => {
  home = tempHome();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "atrium-open-")));
  log = join(home.home, "open.log");
  process.env.FAKE_OPEN_LOG = log;
});
afterEach(() => {
  delete process.env.FAKE_OPEN_LOG;
  delete process.env.FAKE_OPEN_EXIT;
  home.cleanup();
  rmSync(dir, { recursive: true, force: true });
});
const file = (name: string, mode = 0o644, body = "x") => {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return name;
};
const target = (name: string) => resolveTarget(dir, name);
const logged = (): string[][] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const copies = () => join(config().home, "open-copies");

test("tempHome points open at the fake", () => {
  expect(process.env.ATRIUM_OPEN_BIN).toEndWith("tests/fixtures/fake-open.ts");
});

test("open launches a private copy in a named app; reveal uses the real path", async () => {
  file("list.md", 0o644, "- milk\n");
  file("run.command", 0o755);
  file("week.ics", 0o644, "BEGIN:VCALENDAR\n");
  file("scan.pdf");
  file("chart.png");
  expect(await openFile(target("list.md"), "open")).toEqual({ app: "TextEdit", copy: true });
  expect(await openFile(target("run.command"), "reveal")).toEqual({ app: "Finder", copy: false });
  expect(await openFile(target("week.ics"), "calendar")).toEqual({ app: "Calendar", copy: true });
  await openFile(target("scan.pdf"), "open");
  await openFile(target("chart.png"), "open");
  const [md, reveal, ics, pdf, png] = logged();
  expect(md!.slice(0, 2)).toEqual(["-a", "TextEdit"]);
  expect(md![2]!.startsWith(copies() + "/")).toBe(true);
  expect(md![2]!.endsWith("/list.md")).toBe(true);
  expect(readFileSync(md![2]!, "utf8")).toBe("- milk\n");
  expect(statSync(join(md![2]!, "..")).mode & 0o777).toBe(0o700);
  expect(reveal).toEqual(["-R", join(dir, "run.command")]);
  expect(ics!.slice(0, 2)).toEqual(["-a", "Calendar"]);
  expect(readFileSync(ics![2]!, "utf8")).toBe("BEGIN:VCALENDAR\n");
  expect(pdf!.slice(0, 2)).toEqual(["-a", "Preview"]);
  expect(png!.slice(0, 2)).toEqual(["-a", "Preview"]);
});

test("open refuses anything that could run code", async () => {
  const msg = "Atrium won't open this kind of file directly, since it could run code. Use Reveal in Finder to look at it.";
  mkdirSync(join(dir, "Thing.app"));
  for (const name of [file("run.command"), file("tool.sh"), file("page.html"), file("notes.md", 0o755)]) {
    await expect(openFile(target(name), "open")).rejects.toThrow(msg);
  }
  await expect(openFile(resolveTarget(dir, "."), "open")).rejects.toThrow(msg);
  await expect(openFile(target(file("list.md")), "calendar")).rejects.toThrow("Only .ics files can be added to Calendar.");
  expect(logged()).toEqual([]);
});

test("a file swapped after the check is never opened or revealed", async () => {
  const secret = join(dir, "..", `secret-${Date.now()}.md`);
  writeFileSync(secret, "secret");
  try {
    file("notes.md");
    const t = target("notes.md");
    rmSync(join(dir, "notes.md"));
    symlinkSync(secret, join(dir, "notes.md"));
    const msg = "That file changed while Atrium was checking it. Try again.";
    await expect(openFile(t, "open")).rejects.toThrow(msg);
    await expect(openFile(t, "reveal")).rejects.toThrow(msg);
    // Another file at the same path (a new inode) is refused too.
    rmSync(join(dir, "notes.md"));
    writeFileSync(join(dir, "notes.md"), "swapped");
    await expect(openFile(t, "open")).rejects.toThrow(msg);
    expect(logged()).toEqual([]);
  } finally {
    rmSync(secret, { force: true });
  }
});

test("odd names stay one argument", async () => {
  await openFile(target(file("-rf.md")), "open");
  await openFile(target(file("a b ü.md")), "open");
  const l = logged();
  expect(l.map((a) => a.length)).toEqual([3, 3]);
  for (const args of l) expect(args[2]!.startsWith("/")).toBe(true);
  expect(l[1]![2]!.endsWith("/a b ü.md")).toBe(true);
});

test("a failed open says what to do", async () => {
  process.env.FAKE_OPEN_EXIT = "1";
  await expect(openFile(target(file("list.md")), "open")).rejects.toThrow("macOS couldn't open list.md. Use Reveal in Finder and open it from there.");
});

test("Add to Calendar drops alarms that could run, mail or fetch something", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Gym",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Gym in 15 minutes",
    "TRIGGER:-PT15M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:PROCEDURE",
    "ATTACH:file:///Users/n/evil.sh",
    "TRIGGER:-PT5M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:EMAIL",
    "ATTENDEE:mailto:someone@example.com",
    "TRIGGER:-PT1M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:AUDIO",
    "ATTACH;VALUE=URI:https://tracker.example/s",
    " ound.aiff",
    "TRIGGER:-PT2M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:AUDIO",
    "TRIGGER:-PT3M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "URL:https://tracker.example/x",
    "TRIGGER:-PT4M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  file("week.ics", 0o644, ics);
  await openFile(target("week.ics"), "calendar");
  const copy = readFileSync(logged()[0]![2]!, "utf8");
  expect(copy.match(/BEGIN:VALARM/g)?.length).toBe(2);
  expect(copy).toContain("DESCRIPTION:Gym in 15 minutes");
  expect(copy).toContain("TRIGGER:-PT3M");
  for (const gone of ["PROCEDURE", "evil.sh", "EMAIL", "someone@", "tracker.example", "ound.aiff"]) expect(copy).not.toContain(gone);
  expect(copy).toContain("SUMMARY:Gym\r\n");
  // The file in the space is untouched.
  expect(readFileSync(join(dir, "week.ics"), "utf8")).toBe(ics);
});
