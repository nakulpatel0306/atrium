import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChangesList } from "../../src/dashboard/components/ChangesView";
import { LoopPanel } from "../../src/dashboard/components/LoopPanel";
import { MemoryProposals } from "../../src/dashboard/components/Memory";
import { RetroCard, RollupCard } from "../../src/dashboard/components/Retro";
import { spotLink, WalkthroughCard } from "../../src/dashboard/components/Walkthrough";
import type { DiffResult } from "../../src/engine/diff-parse";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import type { Walkthrough } from "../../src/engine/walkthrough";
import { ids, makeState } from "../tui/fixtures";

type Task = State["tasks"][number];

let calls: { url: string; body: unknown }[] = [];
let reply: unknown = {};
let root: Root | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  reply = {};
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(reply);
  }) as typeof fetch;
});
afterEach(() => {
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
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text));
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

const walkthrough = (over: Partial<Walkthrough> = {}): Walkthrough => ({
  approach: "It adds an optional coupon to the total and clamps it.",
  decisions: [{ chose: "Clamp the percentage", rejected: "throwing on bad input" }],
  risks: [{ file: "src/cart.ts", line: 8, note: "NaN passes the clamp" }],
  look: [{ file: "src/cart.ts", line: 9, note: "the rounding" }],
  predict: null,
  sha: "abc",
  by: "codex",
  source: "review",
  ...over,
});

function setup(loop: Partial<NonNullable<Task["loop"]>>, status: Task["status"] = "review", learning: "off" | "light" | "deep" = "light") {
  const state = makeState();
  state.spaces[0] = { ...state.spaces[0]!, learning };
  const base = state.tasks.find((t) => t.id === ids.review)!;
  const task: Task = { ...base, spaceId: state.spaces[0]!.id, status, loop: { ...newLoop(SIZE_BUDGETS.medium), checkedSha: "abc", ...loop } };
  state.tasks = state.tasks.map((t) => (t.id === task.id ? task : t));
  return { state, task, space: state.spaces[0]! };
}

test("the walkthrough shows above the diff with its spots linking into the Changes at their hunk", () => {
  const { task, space } = setup({ walkthrough: walkthrough() });
  const el = render(<WalkthroughCard task={task} space={space} />);
  const all = el.textContent!;
  for (const s of ["Walkthrough", "by Codex, in its review", "It adds an optional coupon", "Clamp the percentage · over throwing on bad input", "Risky spots", "Where to look first", "src/cart.ts:9 the rounding"]) expect(all).toContain(s);
  expect(spotLink(task, { file: "src/a b.ts", line: 9, note: "" })).toBe(`/space/${task.spaceId}?task=${task.id}&view=changes&file=src%2Fa%20b.ts&line=9`);
  act(() => button(el, "src/cart.ts:9")!.click());
  expect(location.search).toBe(`?task=${task.id}&view=changes&file=src%2Fcart.ts&line=9`);
});

test("no walkthrough yet offers to write one; one for an earlier commit says so; learning off shows nothing", async () => {
  const empty = setup({ walkthrough: null });
  const el = render(<WalkthroughCard task={empty.task} space={empty.space} />);
  expect(el.textContent).toContain("Not written yet.");
  act(() => button(el, "Write it now")!.click());
  await settle();
  expect(calls.map((c) => c.url)).toEqual([`/api/tasks/${empty.task.id}/walkthrough`]);
  act(() => root!.unmount());
  root = null;

  const stale = setup({ walkthrough: walkthrough({ sha: "old" }) });
  expect(render(<WalkthroughCard task={stale.task} space={stale.space} />).textContent).toContain("Written before the last turn changed the branch.");
  act(() => root!.unmount());
  root = null;

  const off = setup({ walkthrough: walkthrough() }, "review", "off");
  expect(render(<WalkthroughCard task={off.task} space={off.space} />).textContent).toBe("");
});

test("deep mode asks first, with one click or a skip, and then reveals the answer beside the walkthrough", async () => {
  const predict = { question: "What does a 150% coupon do?", options: ["Throws", "Clamps to zero", "Goes negative"], answer: 1, guess: null, skipped: false };
  const open = setup({ walkthrough: walkthrough({ predict }) }, "review", "deep");
  const el = render(<WalkthroughCard task={open.task} space={open.space} />);
  expect(el.textContent).toContain("Before you read it: What does a 150% coupon do?");
  expect(el.textContent).not.toContain("It adds an optional coupon");
  act(() => button(el, "Clamps to zero")!.click());
  await settle();
  expect(calls).toEqual([{ url: `/api/tasks/${open.task.id}/predict`, body: { guess: 1 } }]);
  act(() => button(el, "Skip")!.click());
  await settle();
  expect(calls[1]!.body).toEqual({ guess: null });
  act(() => root!.unmount());
  root = null;

  const wrong = setup({ walkthrough: walkthrough({ predict: { ...predict, guess: 2 } }) }, "review", "deep");
  expect(render(<WalkthroughCard task={wrong.task} space={wrong.space} />).textContent).toContain(`You picked "Goes negative". It's: Clamps to zero`);
});

test("each hunk offers an explanation from the engine, shown under its header", async () => {
  const diff: DiffResult = {
    files: [{ path: "src/cart.ts", status: "modified", additions: 1, deletions: 0, binary: false, truncated: false, hunks: [{ header: "@@ -1,2 +1,3 @@", lines: [{ kind: "add", text: "x", newNo: 2 }] }] }],
    totals: { files: 1, additions: 1, deletions: 0 },
    truncated: false,
  };
  reply = { note: "It guards the total against a bad coupon.", cached: false };
  const el = render(<ChangesList diff={diff} live={null} taskId="tsk_1" at={{ file: "src/cart.ts", line: 2 }} />);
  expect(el.querySelector(".chg-hunk.focus")).not.toBeNull();
  act(() => button(el, "Explain this hunk")!.click());
  await settle();
  expect(calls).toEqual([{ url: "/api/tasks/tsk_1/explain-hunk", body: { file: "src/cart.ts", index: 0, header: "@@ -1,2 +1,3 @@" } }]);
  expect(el.querySelector(".chg-explained")!.textContent).toBe("It guards the total against a bad coupon.");
  // Without a task (a plain render), no hunk offers one.
  act(() => root!.unmount());
  root = null;
  expect(button(render(<ChangesList diff={diff} live={null} />), "Explain this hunk")).toBeUndefined();
});

test("a loop pause on a repeated failure leads with the diagnosis; a budget pause leads with the hint", () => {
  const paused = { paused: { kind: "loop" as const, diagnosis: "The same check failed the same way twice in a row (test)." } };
  const loop = setup(paused, "blocked");
  const el = render(<LoopPanel task={loop.task} state={loop.state} repo showChecks={false} />);
  expect(el.textContent).toContain("Want the diagnosis instead of another attempt?");
  expect(button(el, "Explain the problem instead")!.className).toBe("btn p");
  expect(button(el, "Give it a hint")!.className).toBe("btn");
  act(() => root!.unmount());
  root = null;
  const budget = setup({ paused: { kind: "budget", diagnosis: "It worked for 45 minutes, its budget." } }, "blocked");
  const b = render(<LoopPanel task={budget.task} state={budget.state} repo showChecks={false} />);
  expect(b.textContent).not.toContain("Want the diagnosis");
  expect(button(b, "Give it a hint")!.className).toBe("btn p");
});

test("the retro and the roll-up show only the measured lines the engine sent", () => {
  const { state, task } = setup({}, "done");
  expect(render(<RetroCard task={task} state={state} />).textContent).toBe("");
  act(() => root!.unmount());
  root = null;
  state.learning.retros[task.id] = { lines: ["You steered 1 time · no rework · no late check failures.", "~$0.10 est. (20k weighted tokens). Not enough medium tasks in this space to compare yet.", "Next time: Nothing stood out: keep briefs this specific."] };
  state.learning.rollups.all = { tasks: 5, lines: ["This week (5): median $0.20 est., 0.4 rework turns each"] };
  const el = render(
    <>
      <RetroCard task={task} state={state} />
      <RollupCard state={state} spaceId={null} />
      <RollupCard state={state} spaceId="spc_none" />
    </>,
  );
  expect(el.textContent).toContain("How directing it went");
  expect(el.textContent).toContain("Next time: Nothing stood out");
  expect(el.textContent).toContain("What paid off this weekmeasured on 5 finished tasks");
  expect(el.querySelectorAll(".rollup")).toHaveLength(1);
});

test("a proposed CLAUDE.md line is shown exactly, edited, and accepted with the user's text", async () => {
  const { state, space } = setup({});
  state.learning.memory = [{ id: "mem_1", spaceId: space.id, taskId: null, source: "steer", line: "Money is cents.", why: 'From your steer on "Cart".', status: "open", branch: null, commitSha: null, createdAt: 1 }];
  reply = { lines: 12, budget: 200, missing: false, problem: null };
  const el = render(<MemoryProposals state={state} space={space} />);
  await settle();
  const input = el.querySelector("input")!;
  expect(input.value).toBe("Money is cents.");
  expect(el.textContent).toContain("CLAUDE.md: 12 of 200 lines");
  // happy-dom's inputs don't trip React's change tracking, so typing goes straight to the input's onChange.
  const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
  act(() => (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void }>)[key]!.onChange({ target: { value: "Money is integer cents." } }));
  act(() => button(el, "Add it")!.click());
  await settle();
  expect(calls.at(-1)).toEqual({ url: "/api/memory/mem_1", body: { action: "accept", line: "Money is integer cents." } });
});
