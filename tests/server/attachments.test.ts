import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/engine/db";
import { spaceFolder } from "../../src/engine/folders";
import { createSpace, type Space } from "../../src/engine/spaces";
import { getTask } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let kicks = 0;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  kicks = 0;
  server = startServer({ db, runner: { kick: () => void kicks++ }, setup: async () => { throw new Error("no"); }, port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
  home.cleanup();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const file = (name: string, bytes: Uint8Array<ArrayBuffer> | string = PNG) => new File([bytes], name);

function upload(space: Space | string, files: File[], headers: Record<string, string> = { origin: base }) {
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);
  return fetch(`${base}/api/spaces/${typeof space === "string" ? space : space.id}/attachments`, { method: "POST", headers, body: form });
}
const command = (body: unknown) =>
  fetch(`${base}/api/command`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
const general = (name = "Flat Costs") => createSpace(db, { name, kind: "general", goal: "" });
const stored = (s: Space) => readdirSync(join(spaceFolder(s), "Attachments")).sort();

test("uploads land in the space's Attachments folder and come back with ids", async () => {
  const s = general();
  const res = await upload(s, [file("receipt.png"), file("notes.md", "# split\n")]);
  expect(res.status).toBe(200);
  const out = (await res.json()) as { id: string; name: string; size: number; type: string }[];
  expect(out.map((a) => [a.name, a.size, a.type])).toEqual([
    ["receipt.png", PNG.length, "image/png"],
    ["notes.md", 8, "text/markdown"],
  ]);
  expect(out.every((a) => a.id.startsWith("att_"))).toBe(true);
  expect(stored(s)).toEqual(["notes.md", "receipt.png"]);
  expect(readFileSync(join(spaceFolder(s), "Attachments", "receipt.png"))).toEqual(Buffer.from(PNG));
});

test("sending with attachments puts the files in the task's detail and claims them", async () => {
  const s = general();
  const ids = ((await (await upload(s, [file("receipt.png")])).json()) as { id: string }[]).map((a) => a.id);
  const res = await command({ text: "Split this three ways", spaceId: s.id, attachments: ids });
  expect(res.status).toBe(200);
  const { task } = (await res.json()) as { task: { id: string; title: string; detail: string } };
  expect(task.title).toBe("Split this three ways");
  expect(task.detail).toBe("Split this three ways\n\nAttached files (in this space's folder):\n- Attachments/receipt.png");
  expect(kicks).toBe(1);
  const state = (await (await fetch(`${base}/api/state`)).json()) as { attachments: { taskId: string; path: string }[] };
  expect(state.attachments).toEqual([expect.objectContaining({ taskId: task.id, path: "Attachments/receipt.png" })]);
  // Claimed once: the same ids can't ride along on a second task.
  expect((await command({ text: "Again", spaceId: s.id, attachments: ids })).status).toBe(400);
});

test("files with no words ask the agent to look at them; no files and no words is still refused", async () => {
  const s = general();
  const ids = ((await (await upload(s, [file("receipt.png")])).json()) as { id: string }[]).map((a) => a.id);
  const { task } = (await (await command({ text: "", spaceId: s.id, attachments: ids })).json()) as { task: { title: string; detail: string } };
  expect(task.title).toBe("Look at the attached files.");
  expect(task.detail).toContain("- Attachments/receipt.png");
  expect((await command({ text: "", spaceId: s.id })).status).toBe(400);
});

test("POST /api/tasks takes attachments too", async () => {
  const s = general();
  const ids = ((await (await upload(s, [file("list.csv", "a,b\n")])).json()) as { id: string }[]).map((a) => a.id);
  const res = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ spaceId: s.id, title: "Total it", attachments: ids }),
  });
  expect(res.status).toBe(200);
  const t = (await res.json()) as { id: string };
  expect(getTask(db, t.id)!.detail).toBe("Attached files (in this space's folder):\n- Attachments/list.csv");
});

test("another space's attachment id is refused, and nothing is created", async () => {
  const a = general("Flat Costs");
  const b = general("Trip Plans");
  const ids = ((await (await upload(a, [file("receipt.png")])).json()) as { id: string }[]).map((x) => x.id);
  const res = await command({ text: "Look", spaceId: b.id, attachments: ids });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("isn't in this space");
  expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
  expect((await command({ text: "Look", spaceId: a.id, attachments: ["att_nope00"] })).status).toBe(400);
  expect((await command({ text: "Look", spaceId: a.id, attachments: "att_x" })).status).toBe(400);
});

test("type, size and count limits are refused with the file named", async () => {
  const s = general();
  const bad = await upload(s, [file("run.sh", "echo hi")]);
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("run.sh isn't a type Atrium can attach. Use images, PDFs, text, Markdown, CSV, JSON, Excel or Word files.");
  const big = await upload(s, [file("scan.pdf", new Uint8Array(25 * 1024 * 1024 + 1))]);
  expect(big.status).toBe(413);
  expect(((await big.json()) as { error: string }).error).toBe("scan.pdf is over 25 MB, so Atrium won't attach it.");
  const many = await upload(s, Array.from({ length: 11 }, (_, i) => file(`p${i}.png`)));
  expect(many.status).toBe(413);
  const total = await upload(s, Array.from({ length: 5 }, (_, i) => file(`p${i}.pdf`, new Uint8Array(21 * 1024 * 1024))));
  expect(total.status).toBe(413);
  expect(((await total.json()) as { error: string }).error).toContain("more than 100 MB");
  expect(existsSync(join(spaceFolder(s), "Attachments")) ? stored(s) : []).toEqual([]);
});

test("names are cleaned: no folders, no hidden or secrets files, nothing invisible, at most 120 characters", async () => {
  const s = general();
  const env = await upload(s, [file(".env", "KEY=1")]);
  expect(env.status).toBe(400);
  expect(((await env.json()) as { error: string }).error).toContain("looks like a secrets file");
  expect((await upload(s, [file(".env.png")])).status).toBe(400);
  expect((await upload(s, [file("prod.env")])).status).toBe(400);
  expect((await upload(s, [file("id_rsa")])).status).toBe(400);

  const long = `${"a".repeat(200)}.png`;
  const res = await upload(s, [file("../../x.png"), file(".hidden.png"), file(long), file("re‮gnp.png"), file("Café ü.png"), file("a\u0007b.png")]);
  expect(res.status).toBe(200);
  const names = ((await res.json()) as { name: string }[]).map((a) => a.name);
  expect(names[0]).toBe("x.png");
  expect(names[1]).toBe("hidden.png");
  expect(names[2]!.length).toBe(120);
  expect(names[2]!.endsWith(".png")).toBe(true);
  expect(names[3]).toBe("regnp.png");
  expect(names[4]).toBe("Café ü.png".normalize("NFC"));
  expect(names[5]).toBe("ab.png");
  // Nothing escaped the folder.
  expect(existsSync(join(spaceFolder(s), "x.png"))).toBe(false);
  expect(readdirSync(join(spaceFolder(s), "Attachments")).every((n) => !n.startsWith("."))).toBe(true);
});

test("a name that's taken gets a number; nothing is overwritten", async () => {
  const s = general();
  mkdirSync(join(spaceFolder(s), "Attachments"), { recursive: true });
  writeFileSync(join(spaceFolder(s), "Attachments", "receipt.png"), "mine");
  const res = await upload(s, [file("receipt.png"), file("receipt.png"), file("RECEIPT.png")]);
  const names = ((await res.json()) as { name: string }[]).map((a) => a.name);
  expect(names).toEqual(["receipt (2).png", "receipt (3).png", "RECEIPT (4).png"]);
  expect(readFileSync(join(spaceFolder(s), "Attachments", "receipt.png"), "utf8")).toBe("mine");
});

test("a link planted where a file would go isn't followed", async () => {
  const s = general();
  const outside = mkdtempSync(join(tmpdir(), "atrium-outside-"));
  try {
    const target = join(outside, "victim.png");
    writeFileSync(target, "keep");
    mkdirSync(join(spaceFolder(s), "Attachments"), { recursive: true });
    symlinkSync(target, join(spaceFolder(s), "Attachments", "receipt.png"));
    symlinkSync(join(outside, "new.png"), join(spaceFolder(s), "Attachments", "dangling.png"));
    const res = await upload(s, [file("receipt.png"), file("dangling.png")]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }[]).map((a) => a.name)).toEqual(["receipt (2).png", "dangling (2).png"]);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(existsSync(join(outside, "new.png"))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an Attachments folder swapped for a link is refused, and nothing is written outside", async () => {
  const s = general();
  const outside = mkdtempSync(join(tmpdir(), "atrium-outside-"));
  try {
    mkdirSync(spaceFolder(s), { recursive: true });
    symlinkSync(outside, join(spaceFolder(s), "Attachments"));
    const res = await upload(s, [file("receipt.png")]);
    expect(res.status).toBe(409);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(spaceFolder(s), "Attachments")).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a repo space refuses attachments", async () => {
  const s = createSpace(db, { name: "Code", kind: "repo", goal: "", repoPath: home.home });
  const res = await upload(s, [file("receipt.png")]);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe("Attach files in a regular space for now.");
  expect((await command({ text: "Look", spaceId: s.id, attachments: ["att_x"] })).status).toBe(400);
});

test("uploads need the dashboard's own origin", async () => {
  const s = general();
  expect((await upload(s, [file("receipt.png")], {})).status).toBe(403);
  expect((await upload(s, [file("receipt.png")], { origin: "https://evil.example.com" })).status).toBe(403);
  expect(existsSync(join(spaceFolder(s), "Attachments"))).toBe(false);
});

test("an upload that isn't multipart, or names no space, is refused", async () => {
  const s = general();
  const json = await fetch(`${base}/api/spaces/${s.id}/attachments`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" });
  expect(json.status).toBe(415);
  expect((await upload("spc_nope00", [file("receipt.png")])).status).toBe(404);
  expect((await upload(s, [])).status).toBe(400);
});
