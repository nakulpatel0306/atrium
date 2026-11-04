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

// Reads the whole stream in the background so output after the first wait isn't lost.
function collect(stream: ReadableStream<Uint8Array>) {
  let seen = "";
  const done = (async () => {
    const decoder = new TextDecoder();
    for await (const part of stream) seen += decoder.decode(part, { stream: true });
  })();
  return {
    done,
    text: () => seen,
    async waitFor(text: string) {
      const until = Date.now() + 10_000;
      while (!seen.includes(text)) {
        if (Date.now() > until) throw new Error(`no "${text}" in: ${seen}`);
        await Bun.sleep(20);
      }
    },
  };
}

test("a second engine exits without touching task state", async () => {
  const port = freePort();
  const first = engine(port);
  await collect(first.stdout as ReadableStream<Uint8Array>).waitFor("Atrium running at");

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

test("SIGTERM shuts down once and exits 0, even with a second signal", async () => {
  const port = freePort();
  const p = engine(port);
  const out = collect(p.stdout as ReadableStream<Uint8Array>);
  await out.waitFor("Atrium running at");
  // Two identical pending signals merge into one, so the second stop request is a SIGINT.
  p.kill("SIGTERM");
  p.kill("SIGINT");
  expect(await p.exited).toBe(0);
  await out.done;
  expect(out.text().match(/Atrium stopping/g)).toEqual(["Atrium stopping"]);
}, 15_000);
