import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/engine/db";
import { createSpace } from "../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../src/engine/tasks";
import { tempHome } from "./helpers";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let home: ReturnType<typeof tempHome>;
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill("SIGKILL");
    await p.exited;
  }
  home.cleanup();
});

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

function engine(port: number) {
  const p = Bun.spawn(["bun", MAIN], {
    env: { ...process.env, ATRIUM_HOME: home.home, ATRIUM_PORT: String(port), ATRIUM_CLAUDE_BIN: FAKE },
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(p);
  return p;
}

async function waitForLine(stream: ReadableStream<Uint8Array>, text: string) {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const part of stream) {
    seen += decoder.decode(part, { stream: true });
    if (seen.includes(text)) return seen;
  }
  throw new Error(`stream ended without "${text}": ${seen}`);
}

test("a second engine exits without touching task state", async () => {
  const port = freePort();
  const first = engine(port);
  await waitForLine(first.stdout as ReadableStream<Uint8Array>, "Atrium running at");

  const db = openDb();
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  const t = createTask(db, { spaceId: s.id, title: "Mid-run" });
  setTaskStatus(db, t.id, "running");

  const second = engine(port);
  const [code, out, err] = await Promise.all([
    second.exited,
    new Response(second.stdout as ReadableStream).text(),
    new Response(second.stderr as ReadableStream).text(),
  ]);
  expect(code).toBe(1);
  expect(`${out}${err}`.trim()).toBe(`Atrium is already running at http://127.0.0.1:${port}`);
  expect(getTask(db, t.id)!.status).toBe("running");
  db.close();
}, 15_000);
