import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import { join } from "node:path";
import { click, screen } from "../../scripts/tui-screen";
import { openDb } from "../../src/engine/db";
import { startServer, type WsData } from "../../src/server/server";
import { MOUSE_OFF, MOUSE_ON } from "../../src/tui/mouse";
import { tempHome } from "../helpers";
import { seedReview } from "./seed";

let home: ReturnType<typeof tempHome>;
let db: Database;
let server: Server<WsData>;
let port: number;
let ansi: Awaited<ReturnType<typeof screen>>;

// Each run pins its own color mode, whatever terminal the tests run in.
const ANSI_ENV = { COLORTERM: undefined, TERM: "xterm-256color", TERM_PROGRAM: undefined, NO_COLOR: undefined, FORCE_COLOR: undefined };
const TRUECOLOR_ENV = { ...ANSI_ENV, COLORTERM: "truecolor" };

beforeAll(async () => {
  home = tempHome();
  db = openDb();
  seedReview(db);
  server = startServer({ db, runner: { kick: () => {} }, setup: async () => { throw new Error("no setup"); }, port: 0 });
  port = server.port as number;
  ansi = await screen({ port, env: ANSI_ENV, steps: [{ wait: 1500 }, "j", { wait: 200 }, "q"] });
});
afterAll(async () => {
  await server.stop(true);
  db.close();
  home.cleanup();
});

test("atrium opens, moves, and quits cleanly under a pty", async () => {
  const shown = await screen({ port, env: ANSI_ENV, steps: [{ wait: 1500 }, "2", { wait: 300 }, "?", { wait: 300 }] });
  expect(ansi.text).toContain("NEEDS YOU  1");
  expect(ansi.text).toContain("Review: Fix login redirect");
  expect(shown.text).toContain("Keys");
  expect(shown.text).toContain("new task, new space");
  expect(ansi.exitCode).toBe(0);
  expect(ansi.raw).toContain("\x1b[?1049h");
  expect(ansi.raw).toContain("\x1b[?1049l");
}, 20_000);

test("at 80×24 it lays out on purpose: what is running folds under the cards", async () => {
  const small = await screen({ port, cols: 80, rows: 24, env: ANSI_ENV, steps: [{ wait: 1500 }] });
  expect(small.text).toContain("NEEDS YOU  1");
  expect(small.text).toContain("RUNNING");
  expect(small.text).toContain("Ask Atrium");
  expect(small.exitCode).toBe(0);
}, 20_000);

test("in a 16-color terminal only the terminal's own colors are used", () => {
  for (const seq of ["\x1b[38;2;", "\x1b[48;2;", "\x1b[38;5;", "\x1b[48;5;"]) expect(ansi.raw).not.toContain(seq);
  expect(ansi.raw).toMatch(/\x1b\[3[0-7]m|\x1b\[9[0-7]m/);
});

test("in a truecolor terminal it uses Atrium's palette and paints no background behind the screen", async () => {
  const tc = await screen({ port, env: TRUECOLOR_ENV, steps: [{ wait: 1500 }] });
  // The accent, #7c7cf5.
  expect(tc.raw).toContain("38;2;124;124;245");
  // The dashboard's page background is never painted; the terminal's own shows through.
  expect(tc.raw).not.toContain("48;2;13;13;15");
  // Faint text, #868690; high contrast draws it in the terminal's own foreground instead.
  expect(tc.raw).toContain("38;2;134;134;144");
  const hc = await screen({ port, env: { ...TRUECOLOR_ENV, ATRIUM_HIGH_CONTRAST: "1" }, steps: [{ wait: 1500 }] });
  expect(hc.raw).not.toContain("38;2;134;134;144");
  expect(hc.raw).toContain("38;2;124;124;245");
}, 30_000);

test("NO_COLOR drops color but keeps the selected tab readable", async () => {
  const plain = await screen({ port, env: { ...TRUECOLOR_ENV, NO_COLOR: "1" }, steps: [{ wait: 1500 }] });
  expect(plain.raw).not.toMatch(/\x1b\[(3[0-79]|9[0-7]|38;)/);
  expect(plain.raw).toContain("\x1b[7m");
}, 20_000);

test("mouse reporting is on while it runs and off when it quits; a click switches tabs", async () => {
  // " ◆ atrium  " is 12 columns at 120 wide; "2 Spaces" starts after " 1 Home " and a space.
  const clicked = await screen({ port, env: ANSI_ENV, steps: [{ wait: 1500 }, click(24, 0), { wait: 300 }] });
  expect(clicked.text).toContain("SPACES");
  expect(clicked.text).toContain("TASKS · atrium");
  expect(clicked.raw).toContain(MOUSE_ON);
  expect(clicked.raw.lastIndexOf(MOUSE_OFF)).toBeGreaterThan(clicked.raw.lastIndexOf(MOUSE_ON));
  // A mouse report never shows up as typed text.
  expect(clicked.text).not.toContain("[<0;");
}, 20_000);

test("atrium tui without a terminal explains itself", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli.ts"), "tui"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("atrium needs a terminal");
});
