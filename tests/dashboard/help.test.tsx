import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Activity } from "../../src/dashboard/components/Activity";
import { LoopPanel } from "../../src/dashboard/components/LoopPanel";
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
  expect([...card.querySelectorAll("button")].map((b) => [b.textContent, b.className])).toEqual([["Open Get started", "btn"]]);
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
});
