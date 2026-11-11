import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedBlock, batchRefusal, cleanName, refusal, withoutBlock } from "../../src/engine/attachment-rules";
import { claimAttachments, copyAttachments, removeCopies, storeAttachments, taskAttachments } from "../../src/engine/attachments";
import { openDb } from "../../src/engine/db";
import { deleteTask } from "../../src/engine/delete";
import { spaceFolder } from "../../src/engine/folders";
import { createSpace } from "../../src/engine/spaces";
import { createTask } from "../../src/engine/tasks";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);

function attachedTask(names: string[]) {
  const s = createSpace(db, { name: "Flat Costs", kind: "general", goal: "" });
  const list = storeAttachments(db, s, names.map((name) => ({ name, bytes: bytes(`data of ${name}`) })));
  const t = createTask(db, { spaceId: s.id, title: "Split it" });
  claimAttachments(db, t.id, list);
  return { s, t, list };
}

test("names keep only the file's own name, without hidden or invisible parts", () => {
  expect(cleanName("../../etc/x.png")).toBe("x.png");
  expect(cleanName("C:\\Users\\sam\\scan.pdf")).toBe("scan.pdf");
  expect(cleanName("...hidden.md")).toBe("hidden.md");
  expect(cleanName("a\u0000b\u001fc.txt")).toBe("abc.txt");
  expect(cleanName("photo\u202Egnp.exe.png")).toBe("photognp.exe.png");
  expect(cleanName("12:30 notes.md")).toBe("12-30 notes.md");
  expect(cleanName("...")).toBe("file");
  const long = cleanName(`${"ü".repeat(150)}.jpeg`);
  expect(long.length).toBe(120);
  expect(long.endsWith(".jpeg")).toBe(true);
});

test("secrets files and other types are refused by name; a full batch is refused as a whole", () => {
  expect(refusal(".env", 3)).toContain("looks like a secrets file");
  expect(refusal("prod.env", 3)).toContain("looks like a secrets file");
  expect(refusal(".ENV.local.png", 3)).toContain("looks like a secrets file");
  expect(refusal("deploy.pem", 3)).toContain("isn't a type Atrium can attach");
  expect(refusal("index.html", 3)).toContain("isn't a type Atrium can attach");
  expect(refusal("receipt.PNG", 3)).toBeNull();
  expect(batchRefusal([{ name: "a.png", size: 1 }], Array.from({ length: 10 }, () => ({ size: 1 })))).toBe("A task can carry at most 10 files.");
});

test("the detail block lists each file, and a screen that lists them itself can take it off", () => {
  const block = attachedBlock(["Attachments/receipt.png", "Attachments/list.csv"]);
  expect(block).toBe("Attached files (in this space's folder):\n- Attachments/receipt.png\n- Attachments/list.csv");
  expect(withoutBlock(`Split it\n\n${block}`)).toBe("Split it");
  expect(withoutBlock(block)).toBe("");
  expect(withoutBlock("Split it")).toBe("Split it");
});

test("a fresh, empty home takes an upload: the space folder and Attachments are made on the way", () => {
  const s = createSpace(db, { name: "Flat Costs", kind: "general", goal: "" });
  expect(existsSync(spaceFolder(s))).toBe(false);
  const [a] = storeAttachments(db, s, [{ name: "receipt.png", bytes: bytes("x") }]);
  expect(readFileSync(join(spaceFolder(s), a!.path), "utf8")).toBe("x");
});

test("deleting a task keeps its attached files and lets go of the link", async () => {
  const { s, t, list } = attachedTask(["receipt.png"]);
  await deleteTask(db, t.id);
  expect(existsSync(join(spaceFolder(s), list[0]!.path))).toBe(true);
  expect(db.query("SELECT task_id FROM attachments").all()).toEqual([{ task_id: null }]);
});

test("copies land at the paths the detail names, and only those copies are removed again", () => {
  const { s, t } = attachedTask(["receipt.png", "list.csv"]);
  const dest = tmp("atrium-scratch-");
  const copied = copyAttachments(db, t.id, spaceFolder(s), dest);
  expect(copied.names).toEqual(["receipt.png", "list.csv"]);
  expect(readFileSync(join(dest, "Attachments", "receipt.png"), "utf8")).toBe("data of receipt.png");
  writeFileSync(join(dest, "Attachments", "agent-notes.md"), "mine");
  removeCopies(copied);
  expect(readdirSync(join(dest, "Attachments"))).toEqual(["agent-notes.md"]);
});

test("Attachments swapped for a link to an outside folder: nothing outside is deleted or written", () => {
  const { s, t } = attachedTask(["receipt.png"]);
  const outside = tmp("atrium-outside-");
  writeFileSync(join(outside, "receipt.png"), "keep me");

  // At copy time: the copy is skipped, and the outside folder is untouched.
  const dest = tmp("atrium-scratch-");
  symlinkSync(outside, join(dest, "Attachments"));
  expect(copyAttachments(db, t.id, spaceFolder(s), dest)).toEqual({ dir: null, names: [] });
  expect(readdirSync(outside)).toEqual(["receipt.png"]);
  expect(readFileSync(join(outside, "receipt.png"), "utf8")).toBe("keep me");

  // After the run: an agent swapped the folder it was given for a link; removing the copies deletes nothing there.
  const dest2 = tmp("atrium-scratch-");
  const copied = copyAttachments(db, t.id, spaceFolder(s), dest2);
  expect(copied.names).toEqual(["receipt.png"]);
  rmSync(join(dest2, "Attachments"), { recursive: true });
  symlinkSync(outside, join(dest2, "Attachments"));
  removeCopies(copied);
  expect(readFileSync(join(outside, "receipt.png"), "utf8")).toBe("keep me");
  expect(lstatSync(join(dest2, "Attachments")).isSymbolicLink()).toBe(true);

  // At upload time: the space's own Attachments swapped for a link is refused.
  rmSync(join(spaceFolder(s), "Attachments"), { recursive: true });
  symlinkSync(outside, join(spaceFolder(s), "Attachments"));
  expect(() => storeAttachments(db, s, [{ name: "new.png", bytes: bytes("x") }])).toThrow("isn't a plain folder");
  expect(readdirSync(outside)).toEqual(["receipt.png"]);
});

test("a parent folder swapped for a link is caught too", () => {
  const { s, t } = attachedTask(["receipt.png"]);
  const outside = tmp("atrium-outside-");
  mkdirSync(join(outside, "Attachments"));
  writeFileSync(join(outside, "Attachments", "receipt.png"), "keep me");
  const dest = join(tmp("atrium-parent-"), "run");
  mkdirSync(dest);
  const copied = copyAttachments(db, t.id, spaceFolder(s), dest);
  expect(copied.names).toEqual(["receipt.png"]);
  // The run folder itself now leads outside, where a plain Attachments folder holds a file of the same name.
  rmSync(dest, { recursive: true });
  symlinkSync(outside, dest);
  removeCopies(copied);
  expect(readFileSync(join(outside, "Attachments", "receipt.png"), "utf8")).toBe("keep me");
});

test("a link in place of an attached file isn't followed, on the way in or out", () => {
  const { s, t, list } = attachedTask(["receipt.png"]);
  const outside = tmp("atrium-outside-");
  writeFileSync(join(outside, "secret.png"), "not yours");
  // The space's copy replaced by a link to somewhere else: it isn't read.
  const src = join(spaceFolder(s), list[0]!.path);
  rmSync(src);
  symlinkSync(join(outside, "secret.png"), src);
  const dest = tmp("atrium-scratch-");
  const none = copyAttachments(db, t.id, spaceFolder(s), dest);
  expect(none.names).toEqual([]);
  expect(existsSync(join(dest, "Attachments", "receipt.png"))).toBe(false);

  // A link the agent put where a copy was: removing copies leaves the link and its target alone.
  symlinkSync(join(outside, "secret.png"), join(dest, "Attachments", "receipt.png"));
  removeCopies({ dir: none.dir, names: ["receipt.png"] });
  expect(lstatSync(join(dest, "Attachments", "receipt.png")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(outside, "secret.png"), "utf8")).toBe("not yours");
  expect(taskAttachments(db, t.id)).toHaveLength(1);
});
