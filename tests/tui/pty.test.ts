import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { join } from "node:path";
import { screen } from "../../scripts/tui-screen";
import { openDb } from "../../src/engine/db";
import { startServer } from "../../src/server/server";
import { tempHome } from "../helpers";
import { seedReview } from "./seed";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<undefined>;
let port: number;
let quit: Awaited<ReturnType<typeof screen>>;

beforeAll(async () => {
  home = tempHome();
  db = openDb();
  seedReview(db);
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no setup"); }, port: 0 });
  port = server.port as number;
  quit = await screen({ port, steps: [{ wait: 1500 }, "j", { wait: 200 }, "q"] });
});
afterAll(async () => {
  await server.stop(true);
  db.close();
  home.cleanup();
});

test("atrium opens, moves, and quits cleanly under a pty", async () => {
  const shown = await screen({ port, steps: [{ wait: 1500 }, "3", { wait: 300 }, "?", { wait: 300 }] });
  // The help overlay covers the left titles, so the panes are checked on the run that only moved.
  expect(quit.text).toContain("[3] Needs you · 1");
  expect(shown.text).toContain("Help · ? or q to close");
  expect(shown.text).toContain("approve");
  expect(quit.exitCode).toBe(0);
  expect(quit.raw).toContain("\x1b[?1049h");
  expect(quit.raw).toContain("\x1b[?1049l");
}, 20_000);

test("only the terminal's own colors are used", () => {
  for (const seq of ["\x1b[38;2;", "\x1b[48;2;", "\x1b[38;5;", "\x1b[48;"]) expect(quit.raw).not.toContain(seq);
  expect(quit.raw).toMatch(/\x1b\[3[0-7]m|\x1b\[9[0-7]m/);
});

test("atrium tui without a terminal explains itself", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli.ts"), "tui"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("atrium needs a terminal");
});
