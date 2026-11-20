import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/engine/db";
import { getSpace } from "../../src/engine/spaces";
import { getProgress } from "../../src/engine/start";
import { getTask } from "../../src/engine/tasks";
import { startServer, type WsData } from "../../src/server/server";
import { tempHome } from "../helpers";

const FIX = join(import.meta.dir, "..", "fixtures");
const OPTIONAL = ["ATRIUM_CODEX_BIN", "ATRIUM_GEMINI_BIN", "ATRIUM_GH_BIN"];
let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let base: string;
let kicks = 0;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "fake-claude.ts");
  // The optional agents and gh are missing here, so Get started's checks never run whatever this Mac has installed,
  // which was slow enough under load to time the test out.
  for (const k of OPTIONAL) process.env[k] = join(FIX, "does-not-exist");
  server = startServer({ db, runner: { kick: () => void kicks++ }, setup: async () => Promise.reject(new Error("not stubbed")), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
  delete process.env.ATRIUM_CLAUDE_BIN;
  for (const k of OPTIONAL) delete process.env[k];
  home.cleanup();
});
const post = (path: string) => fetch(base + path, { method: "POST", headers: { origin: base } });

test("Get started offers the sample with its cost, and running it queues the task and finishes setup", async () => {
  const start = (await (await fetch(`${base}/api/start`)).json()) as { sample: { ask: string; cents: number; seconds: number } };
  expect(start.sample).toEqual({ ask: "Fix the failing cart test", cents: expect.any(Number), seconds: expect.any(Number) });
  const res = await post("/api/start/sample");
  expect(res.status).toBe(200);
  const { spaceId, taskId } = (await res.json()) as { spaceId: string; taskId: string };
  const space = getSpace(db, spaceId)!;
  try {
    expect(getTask(db, taskId)).toMatchObject({ spaceId, status: "queued" });
    expect(getProgress(db).done).toBe(true);
    expect(kicks).toBe(1);
  } finally {
    rmSync(space.repoPath!, { recursive: true, force: true });
  }
});

test("without a working Claude the sample doesn't start", async () => {
  process.env.ATRIUM_CLAUDE_BIN = join(FIX, "does-not-exist");
  const res = await post("/api/start/sample");
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("Claude comes first");
});
