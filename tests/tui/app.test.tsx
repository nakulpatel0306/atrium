import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { spaceStatus } from "../../src/dashboard/summary";
import { fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";
import { KEY, openApp } from "./harness";

afterEach(() => cleanup());

const nudge = { id: "mnd_1", spaceId: ids.atrium, spaceName: "Investing", kind: "import" as const, title: "Time to import October", body: "Amex isn't imported for October yet.", path: "/space/x?tab=money", createdAt: 0 };

test("Home: tabs, the briefing, Needs you as cards, Today, the Ask box and the keys", async () => {
  const state = makeState();
  const app = openApp(fakeClient(state));
  const f = await app.frame((f) => f.includes("NEEDS YOU"));
  for (const s of ["◆ atrium", " 1 Home ", " 2 Spaces ", " 3 Money ", " 4 Investing ", " 5 Activity ", "41%", "AC", state.briefing.greeting, "NEEDS YOU  1", "TODAY", "RUNNING  1", "Add the status bar", "Ask Atrium", "?  help"]) {
    expect(f).toContain(s);
  }
  // The selected card carries its actions.
  expect(f).toContain("◆ Review: Fix login redirect");
  expect(f).toContain(" a  Approve");
  expect(f).toContain(" r  Send back");
});

test("at 80×24 Today folds under the cards and every line fits", async () => {
  const app = openApp(fakeClient(makeState()), { columns: 80, rows: 24 });
  const f = await app.frame((f) => f.includes("NEEDS YOU"));
  const lines = f.split("\n");
  expect(lines).toHaveLength(24);
  for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(80);
  expect(f).toContain("TODAY");
  expect(f).toContain("RUNNING  ");
  expect(f).not.toContain("│ TODAY");
});

test("Spaces: rows carry the one-line status, and Tasks follow the selected space", async () => {
  const state = makeState();
  const app = openApp(fakeClient(state));
  await app.frame((f) => f.includes("1 Home"));
  await app.type("2");
  const f = await app.frame((f) => f.includes("TASKS · atrium"));
  const status = spaceStatus(state.spaces[0]!, state.tasks.filter((t) => t.spaceId === ids.atrium), state).text;
  expect(status.startsWith("Claude running · Add the")).toBe(true);
  expect(f.split("\n").find((l) => l.includes("atrium") && l.includes("Claude running"))).toBeDefined();
  await app.type("j");
  await app.frame((f) => f.includes("TASKS · job hunt"));
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
  await app.frame((f) => f.includes("1 Home"));
});

test("connecting screen before the first state", async () => {
  const app = openApp(fakeClient(null));
  await app.frame((f) => f.includes("Connecting to Atrium…"));
});

test("going offline keeps the last state visible and says so with a word", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("1 Home"));
  client.setOnline(false);
  const f = await app.frame((f) => f.includes("✗ offline · reconnecting"));
  expect(f).toContain("NEEDS YOU");
});

test("too small a window gets one plain sentence", async () => {
  const app = openApp(fakeClient(makeState()), { columns: 70, rows: 20 });
  const f = await app.frame((f) => f.includes("Atrium needs"));
  expect(f.replace(/\s+/g, " ").trim()).toBe("Atrium needs at least 80×24. This window is 70×20.");
});

test("marks the briefing seen once, and keeps the briefing it opened with", async () => {
  const client = fakeClient(makeState());
  const app = openApp(client);
  await app.frame((f) => f.includes("1 Home"));
  await new Promise((r) => setTimeout(r, 20));
  client.push(makeState({ briefing: { greeting: "Good night, Sam.", summary: "Later.", markets: null } }));
  client.push(makeState());
  await new Promise((r) => setTimeout(r, 20));
  expect(client.calls.filter((c) => c.method === "POST" && c.path === "/api/seen")).toHaveLength(1);
  expect(app.lastFrame()).toContain("Good evening, Sam.");
});

test("empty states read plainly", async () => {
  const app = openApp(fakeClient(makeState({ spaces: [], approvals: [], activity: [], tasks: [], runs: [] })));
  const home = await app.frame((f) => f.includes("caught up"));
  expect(home).toContain("You're all caught up.");
  expect(home).toContain("Nothing running.");
  await app.type("2");
  const spaces = await app.frame((f) => f.includes("No spaces yet"));
  expect(spaces).toContain("No spaces yet. Press N and");
  await app.type("5");
  const activity = await app.frame((f) => f.includes("No activity yet"));
  expect(activity).toContain("No activity yet. Agent runs and your decisions will show up here.");
});

test("each key in a chunk sees the tab the one before it set", async () => {
  const app = openApp(fakeClient(makeState()));
  await app.frame((f) => f.includes("1 Home"));
  await app.type("2j");
  await app.frame((f) => f.includes("TASKS · job hunt"));
});

test("engine text can't send escape sequences to the terminal", async () => {
  const evil = "\x1b]52;c;Zm9v\x07\x1b[2J\x9b31m";
  const state = makeState();
  state.tasks[1] = { ...state.tasks[1]!, title: `Add the status bar${evil}` };
  state.activity[0] = { ...state.activity[0]!, message: `finished${evil} it` };
  state.spaces[1] = { ...state.spaces[1]!, name: `job${evil} hunt` };
  const app = openApp(fakeClient(state));
  await app.frame((f) => f.includes("1 Home"));
  await app.type("2", KEY.tab);
  await app.frame((f) => f.includes("TASK  Add the status bar"));
  await app.type("5");
  await app.frame((f) => f.includes("finished it"));
  const out = app.frames.join("");
  expect(out).not.toContain("\x1b]");
  expect(out).not.toContain("\x1b[2J");
  expect(out).not.toContain("\x9b");
});

test("Activity: day headings, one line per group, a mark for its tone, and its full lines beside it", async () => {
  const state = makeState();
  state.activity[0] = { ...state.activity[0]!, createdAt: Date.now() };
  const app = openApp(fakeClient(state));
  await app.frame((f) => f.includes("1 Home"));
  await app.type("5");
  const f = await app.frame((f) => f.includes("ACTIVITY"));
  expect(f).toContain("TODAY");
  expect(f).toMatch(/▌ now\s+· Claude · finished Fix login redirect · atrium/);
  expect(f).toMatch(/15m\s+· You · added Summarize postings · job hunt/);
  expect(f).toContain("LINES");
  expect(f).toContain("Claude: finished Fix login redirect");
});

test("the monthly import reminder is a quiet card; enter opens Money and x dismisses it", async () => {
  const client = fakeClient(makeState({ approvals: [], nudges: [nudge] }));
  const app = openApp(client);
  const f = await app.frame((f) => f.includes("Time to import October"));
  expect(f).toContain("✦ Time to import October");
  expect(f).toContain("Open Money");
  await app.type("x");
  await app.frame((f) => f.includes("Dismissed."));
  expect(client.calls.filter((c) => c.method === "POST" && c.path !== "/api/seen")).toEqual([{ method: "POST", path: `/api/investing/${ids.atrium}/money/nudges/mnd_1/dismiss`, body: undefined }]);
  await app.type(KEY.enter);
  await app.frame((f) => f.includes(" 3 Money ") && f.includes("Investing space yet"));
});

test("more cards than fit say how many are below, and the selected one stays whole", async () => {
  const base = makeState();
  const approvals = Array.from({ length: 9 }, (_, i) => ({ ...base.approvals[0]!, id: `apr_${i}`, title: `Question ${i}`, kind: "question" as const }));
  const app = openApp(fakeClient(makeState({ approvals })), { columns: 80, rows: 24 });
  const f = await app.frame((f) => f.includes("NEEDS YOU  9"));
  expect(f).toMatch(/↓ \d more below/);
  await app.type("G");
  const end = await app.frame((f) => f.includes("? Question 8") && f.includes(" a  Approve"));
  expect(end).toMatch(/↑ \d more above/);
});
