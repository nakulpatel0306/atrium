import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Activity } from "../../src/dashboard/components/Activity";
import { Home } from "../../src/dashboard/components/Home";
import { LoopPanel, StageStrip } from "../../src/dashboard/components/LoopPanel";
import { NeedsPage } from "../../src/dashboard/components/NeedsPage";
import { Settings } from "../../src/dashboard/components/Settings";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import { KIND, PAUSE_WHY } from "../../src/engine/words";
import { ids, makeState, task } from "../tui/fixtures";

type Task = State["tasks"][number];
let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/api/profile")) return Response.json({ name: null, suggestedName: null, projectsRoot: "/Users/sam/Projects" });
    if (url.endsWith("/checks")) return Response.json([]);
    // Anything else (storage, archived spaces) stays loading: these tests read only what's above it.
    return new Promise<Response>(() => {});
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  globalThis.fetch = realFetch;
});
openDom();
afterAll(() => closeDom());

function render(node: React.ReactNode): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(node));
  return el;
}

function pausedOn(kind: "budget" | "loop"): { state: State; task: Task } {
  const state = makeState();
  const t = task({ id: "tsk_p", spaceId: ids.atrium, title: "Ranking", status: "blocked", loop: { ...newLoop(SIZE_BUDGETS.small), paused: { kind, diagnosis: kind === "budget" ? "Another turn would go over the budget." : "The same check failed the same way twice in a row (test)." } } });
  state.tasks.push(t);
  return { state, task: t };
}

test("an item's screen says in plain words what its kind means, so Sign-off and Could split explain themselves", () => {
  const state = makeState();
  state.approvals.push({ ...state.approvals[0]!, id: "apr_q", taskId: null, kind: "question", title: "Publish the changelog?", detail: "" });
  const el = render(<NeedsPage state={state} item="apr_q" />);
  expect(el.querySelector(".dp-head .q-kind")!.textContent).toBe("Sign-off");
  expect(el.querySelector(".dp-means")!.textContent).toBe(KIND.approval.means);
});

test("a pause says why Atrium paused it: what a budget is for, or why a repeated failure stops the loop", () => {
  for (const kind of ["budget", "loop"] as const) {
    const { state, task } = pausedOn(kind);
    const el = render(<LoopPanel task={task} state={state} repo showChecks={false} />);
    expect(el.querySelector(".pause-why")!.textContent).toBe(PAUSE_WHY[kind]);
    act(() => root!.unmount());
    root = null;
  }
});

test("a paused task shows at most three ways on, and changing the budget is a quiet link beside the budget", () => {
  const { state, task } = pausedOn("budget");
  const el = render(<LoopPanel task={task} state={state} repo showChecks={false} />);
  const ways = [...el.querySelectorAll<HTMLButtonElement>(".paused button")].map((b) => b.textContent);
  expect(ways).toEqual([expect.stringMatching(/^Raise to .* and carry on$/), "Give it a hint", "Explain the problem"]);
  const change = [...el.querySelectorAll<HTMLButtonElement>(".budget button")].find((b) => b.textContent === "Change budget")!;
  expect(change.className).toContain("link");
});

test("Settings opens with Get started, saying what it does, rather than a bare link under the name field", async () => {
  const el = render(<Settings state={makeState()} />);
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  const first = el.querySelector(".wrap > h2")!;
  expect(first.textContent).toBe("Get started");
  const card = first.nextElementSibling!;
  expect(card.textContent).toContain("Checks that Claude is ready");
  expect([...card.querySelectorAll("button")].map((b) => [b.textContent, b.className])).toEqual([["Start", "btn"]]);
  // The profile card keeps only its own fields.
  expect([...el.querySelectorAll(".set-card .mk-form ~ button")].length).toBe(0);
});

test("an empty Activity says what will show up and how to start", () => {
  const empty = { ...makeState(), activity: [] };
  expect(render(<Activity state={empty} page />).querySelector(".empty-row")!.textContent).toBe(
    "Nothing has happened yet. When an agent runs or you decide something, it's listed here. Give a space a task in the bar below to start.",
  );
  act(() => root!.unmount());
  root = null;
  expect(render(<Activity state={{ ...empty, spaces: [] }} page />).querySelector(".empty-row")!.textContent).toBe(
    "Nothing has happened yet. When an agent runs or you decide something, it's listed here. Describe your first space in the bar below to start.",
  );
  act(() => root!.unmount());
  root = null;
  expect(render(<Activity state={empty} spaceId={ids.atrium} />).querySelector(".empty-row")!.textContent).toContain("Give this space a task in the bar below to start.");
});

test("Home's line about a stopped task leads to it, so the retry it suggests is one click away", () => {
  const state = makeState();
  const briefing = { greeting: "Good morning.", summary: "" };
  const el = render(<Home state={state} briefing={briefing} onNewSpace={() => {}} />);
  const link = el.querySelector<HTMLAnchorElement>(".brief a")!;
  expect(link.textContent).toBe("Open Summarize postings");
  expect(link.getAttribute("href")).toBe(`/space/${ids.jobHunt}?task=${ids.blocked}`);
});

test("the stage strip marks checks that failed, rather than a passed stage's dot beside a Checks failed chip", () => {
  const t = task({ id: "tsk_f", spaceId: ids.atrium, status: "review", outcome: "done", loop: { ...newLoop(SIZE_BUDGETS.small), stage: "ready", checks: "failed" } });
  const el = render(<StageStrip task={t} />);
  const checks = [...el.querySelectorAll("li")].find((li) => li.textContent === "Checks")!;
  expect(checks.className).toContain("bad");
});

test("an empty queue says everything that lands there, not only results", () => {
  const el = render(<NeedsPage state={{ ...makeState(), approvals: [], proposals: [], tasks: [] }} />);
  expect(el.querySelector(".q-empty .hint")!.textContent).toBe("Results, questions, sign-offs and paused tasks land here when they need you.");
});

test("a stopped task's strip ends on Stopped in red, as a pause ends on Paused", () => {
  const t = task({ id: "tsk_s", spaceId: ids.atrium, status: "blocked", blockedReason: "Claude Code exited with code 1", loop: { ...newLoop(SIZE_BUDGETS.small), stage: "writing" } });
  const on = render(<StageStrip task={t} />).querySelector("li.on")!;
  expect(on.textContent).toBe("Stopped");
  expect(on.className).toContain("bad");
});

test("on a fresh install the empty queue points to how to start, not to being caught up", () => {
  const el = render(<NeedsPage state={{ ...makeState(), spaces: [], approvals: [], proposals: [], tasks: [] }} />);
  expect(el.querySelector(".q-empty")!.textContent).not.toContain("caught up");
  expect(el.querySelector<HTMLAnchorElement>(".q-empty a")!.getAttribute("href")).toBe("/start");
});

test("Get started is found from the palette by help and setup too", async () => {
  const { paletteActions } = await import("../../src/dashboard/palette");
  const go = paletteActions(makeState(), { spaceId: null, theme: "system" }).find((a) => a.id === "go-/start")!;
  expect(go.hint).toBe("Setup and help");
});
