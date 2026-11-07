import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { spaceStatus } from "../../src/dashboard/summary";
import { fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";
import { openApp } from "./harness";

afterEach(() => cleanup());

test("shows the four left panes and the status bar", async () => {
  const state = makeState();
  const app = openApp(fakeClient(state));
  const f = await app.frame((f) => f.includes("[1] Spaces"));
  for (const s of ["[1] Spaces", "[2] Tasks · atrium", "[3] Needs you · 1", "[4] Activity", "[0] Detail", "[5] Live", "41%", state.briefing.greeting]) {
    expect(f).toContain(s);
  }
});

test("space rows carry the one-line status", async () => {
  const state = makeState();
  const app = openApp(fakeClient(state));
  const atrium = state.spaces[0]!;
  const status = spaceStatus(atrium, state.tasks.filter((t) => t.spaceId === ids.atrium), state).text;
  const f = await app.frame((f) => f.includes("[1] Spaces"));
  const row = f.split("\n").find((l) => l.includes("atrium") && l.includes("Claude running"));
  expect(row).toBeDefined();
  expect(status.startsWith("Claude running · Add the")).toBe(true);
  expect(row).toContain("Claude running · Add the");
});

test("j moves the selection and Tasks follow", async () => {
  const app = openApp(fakeClient(makeState()));
  await app.frame((f) => f.includes("[2] Tasks · atrium"));
  await app.type("j");
  await app.frame((f) => f.includes("[2] Tasks · job hunt"));
});

test("offline screen says how to start the engine", async () => {
  const client = fakeClient(null, { online: false });
  const app = openApp(client);
  const f = await app.frame((f) => f.includes("Can't reach"));
  expect(f.replace(/\s+/g, " ")).toContain("Can't reach the Atrium engine at http://127.0.0.1:");
  expect(f).toContain("atrium start");
  expect(f).toContain("reconnects on its own");
  client.push(makeState());
  client.setOnline(true);
  await app.frame((f) => f.includes("[1] Spaces"));
});

test("connecting screen before the first state", async () => {
  const app = openApp(fakeClient(null));
  await app.frame((f) => f.includes("Connecting to Atrium…"));
});

test("offline banner keeps the last state visible", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  client.setOnline(false);
  const f = await app.frame((f) => f.includes("offline · reconnecting"));
  expect(f).toContain("[1] Spaces");
});

test("too small a window gets one plain sentence", async () => {
  const app = openApp(fakeClient(makeState()), { columns: 70, rows: 20 });
  const f = await app.frame((f) => f.includes("Atrium needs"));
  expect(f.replace(/\s+/g, " ").trim()).toBe("Atrium needs at least 80×24. This window is 70×20.");
});

test("marks the briefing seen once", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  await new Promise((r) => setTimeout(r, 20));
  client.push(makeState({ briefing: { greeting: "Good night, Nakul.", summary: "Later.", markets: null } }));
  client.push(makeState());
  await new Promise((r) => setTimeout(r, 20));
  expect(client.calls.filter((c) => c.method === "POST" && c.path === "/api/seen")).toHaveLength(1);
  expect(app.lastFrame()).toContain("Good evening, Nakul.");
});

test("empty states read plainly", async () => {
  const app = openApp(fakeClient(makeState({ spaces: [], approvals: [], activity: [] })));
  const f = await app.frame((f) => f.includes("No spaces yet"));
  expect(f).toContain("No spaces yet. Press N to describe one.");
  expect(f).toContain("You're all caught up.");
  expect(f.replace(/[│\s]+/g, " ")).toContain("No activity yet. Agent runs and your decisions will show up here.");
});

test("each key in a chunk sees the focus the one before it set", async () => {
  const app = openApp(fakeClient(makeState()));
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("3a");
  await app.frame((f) => f.includes('Approved "Review: Fix login redirect".'));
});

test("engine text can't send escape sequences to the terminal", async () => {
  const evil = "\x1b]52;c;Zm9v\x07\x1b[2J\x9b31m";
  const state = makeState();
  state.tasks[1] = { ...state.tasks[1]!, title: `Add the status bar${evil}` };
  state.activity[0] = { ...state.activity[0]!, message: `finished${evil} it` };
  state.spaces[1] = { ...state.spaces[1]!, name: `job${evil} hunt` };
  const app = openApp(fakeClient(state));
  await app.frame((f) => f.includes("[1] Spaces"));
  await app.type("2");
  await app.frame((f) => f.includes("[0] Detail · Add the status bar"));
  const out = app.frames.join("");
  expect(out).not.toContain("\x1b]");
  expect(out).not.toContain("\x1b[2J");
  expect(out).not.toContain("\x9b");
  expect(out).toContain("finished it");
});

test("activity times stay in one narrow column", async () => {
  const state = makeState();
  state.activity[0] = { ...state.activity[0]!, createdAt: Date.now() };
  const app = openApp(fakeClient(state));
  const f = await app.frame((f) => f.includes("[4] Activity"));
  expect(f).toContain("│now    Claude · finished Fix login redirect");
  expect(f).toContain("│15m    You · added Summarize postings · jo");
});

test("the monthly import reminder shows on top of Needs you as a plain line, not an item", async () => {
  const nudge = { id: "mnd_1", spaceId: ids.atrium, spaceName: "Investing", kind: "import" as const, title: "Time to import October", body: "Amex isn't imported for October yet.", path: "/space/x?tab=money", createdAt: 0 };
  const app = openApp(fakeClient(makeState({ nudges: [nudge] })));
  const f = await app.frame((f) => f.includes("Time to import October"));
  expect(f).toContain("✦ Time to import October · Amex");
  expect(f).toContain("[3] Needs you · 1");
});
