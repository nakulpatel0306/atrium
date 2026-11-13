import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NeedsYou } from "../../src/dashboard/components/NeedsYou";
import { CostChip, Fanout, ShapeLine } from "../../src/dashboard/components/Shape";
import { normalizeBrief } from "../../src/engine/brief";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { proposeShape } from "../../src/engine/shape";
import type { State } from "../../src/engine/state";
import { makeState } from "../tui/fixtures";

type Task = State["tasks"][number];

let calls: { url: string; body: unknown }[] = [];
let root: Root | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/pr")) return Response.json({ eligible: true, sha: `sha-of-${url.split("/")[3]}` });
    return Response.json({ opened: [], failed: [] });
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
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;

const PARTS = [
  { title: "Add the endpoint", goal: "Serve totals", files: ["api.ts"] },
  { title: "Write the docs", goal: "Document totals", files: ["docs.md"] },
];
const ctx = { size: "medium" as const, checksFound: true };

function task(over: Partial<Task>, loop: Partial<NonNullable<Task["loop"]>> = {}): Task {
  const base = makeState().tasks[0]!;
  return { ...base, id: "tsk_p", title: "Totals", status: "queued", approvalId: null, brief: normalizeBrief({ goal: "Totals", size: "medium" }), ...over, loop: { ...newLoop(SIZE_BUDGETS.medium), ...loop } };
}

test("a costlier shape waits in Needs you with its reason and estimate; Start sends the shape left chosen", async () => {
  const state = makeState();
  const waiting = task({}, { stage: "brief", shape: proposeShape({ kind: "split", reason: "two independent pieces", parts: PARTS }, ctx) });
  const s = { ...state, approvals: [], proposals: [], tasks: [...state.tasks, waiting] };
  const el = render(<NeedsYou state={s} />);
  expect(el.textContent).toContain("Split into 2 tasks: two independent pieces. It costs more than one writer");
  // No finished tasks in this space yet, so the estimate is the budgets' ceiling.
  expect(el.textContent).toContain("Runs 2 tasks, each with its own budget: up to 1.2M weighted tokens in all.");
  expect(button(el, "Best of 2").disabled).toBe(false);
  await act(async () => button(el, "Single writer").click());
  await act(async () => button(el, "Start").click());
  expect(calls.at(-1)).toEqual({ url: "/api/tasks/tsk_p/answers", body: { answers: [], shape: "single", mixVendors: false } });
});

test("the shape line shows the reason and offers the override only before the writer starts", async () => {
  const shape = proposeShape({ kind: "single", reason: "sequential change in one module" }, { size: "medium", checksFound: false });
  const el = render(<ShapeLine task={task({}, { shape })} state={makeState()} />);
  expect(el.textContent).toContain("Single writer: sequential change in one module");
  await act(async () => button(el, "Change").click());
  // Best-of-N needs a check, and the menu says so instead of offering it.
  expect(button(el, "Best of 2").disabled).toBe(true);
  expect(button(el, "Best of 2").title).toBe("No automatic check to pick between attempts.");
  await act(async () => button(el, "Scouts, then one writer").click());
  expect(calls.at(-1)).toEqual({ url: "/api/tasks/tsk_p/shape", body: { kind: "scouts", mixVendors: false } });
  act(() => root!.render(<ShapeLine task={task({ status: "running" }, { shape })} state={makeState()} />));
  expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Change")).toBe(false);
});

test("ready parts offer their pull requests at the commits shown, a merge, or setting them aside", async () => {
  const state = makeState();
  const part = (id: string, title: string) => task({ id, title, status: "done", branch: `atrium/${id}`, parentTaskId: "tsk_p" }, { stage: "ready", role: "part" });
  const parent = task({}, { stage: "pick", fanout: { kind: "split", children: ["tsk_a", "tsk_b"], scores: {}, judgeNote: null } });
  const s = { ...state, tasks: [...state.tasks, parent, part("tsk_a", "Add the endpoint"), part("tsk_b", "Write the docs")] };
  const el = render(<Fanout task={parent} state={s} />);
  expect(el.textContent).toContain("Parts (2)");
  expect(el.querySelectorAll(".fanout-list .tag.good")).toHaveLength(2);
  await act(async () => button(el, "Open 2 pull requests").click());
  await act(async () => await Bun.sleep(5));
  expect(calls.at(-1)).toEqual({ url: "/api/tasks/tsk_p/parts", body: { action: "prs", shas: { tsk_a: "sha-of-tsk_a", tsk_b: "sha-of-tsk_b" } } });
  await act(async () => button(el, "Merge into one branch").click());
  expect(calls.at(-1)).toEqual({ url: "/api/tasks/tsk_p/parts", body: { action: "merge" } });
});

test("best-of-N shows the survivors side by side, best score first, and the pick is the user's", async () => {
  const state = makeState();
  const attempt = (id: string, status: Task["status"], blockedReason: string | null = null) =>
    task({ id, status, blockedReason, branch: `atrium/${id}`, parentTaskId: "tsk_p" }, { stage: status === "done" ? "ready" : "writing", role: "attempt", checks: status === "done" ? "passed" : "failed" });
  const scores = { tsk_2: { score: 6, comment: "works but slow" }, tsk_3: { score: 9, comment: "cleaner" } };
  const parent = task({}, { stage: "pick", fanout: { kind: "best_of_n", children: ["tsk_1", "tsk_2", "tsk_3"], scores, judgeNote: null } });
  const s = { ...state, tasks: [...state.tasks, parent, attempt("tsk_1", "blocked", "Dropped: its checks failed (Tests)."), attempt("tsk_2", "done"), attempt("tsk_3", "done")] };
  const el = render(<Fanout task={parent} state={s} />);
  const cards = [...el.querySelectorAll(".attempt")].map((c) => c.querySelector("b")!.textContent!.split(" ·")[0]);
  expect(cards).toEqual(["Attempt 3", "Attempt 2", "Attempt 1"]);
  expect(el.textContent).toContain("9/10 cleaner");
  expect(el.textContent).toContain("Dropped: its checks failed (Tests).");
  expect(el.querySelectorAll(".attempt.out button")).toHaveLength(0);
  await act(async () => [...el.querySelectorAll<HTMLButtonElement>(".attempt button")][1]!.click());
  expect(calls.at(-1)).toEqual({ url: "/api/tasks/tsk_p/pick", body: { attempt: "tsk_2" } });
});

test("the cost chip shows weighted tokens and the estimate, with the cache's share on hover", () => {
  const el = render(<CostChip spend={{ weighted: 412_000, usd: 1.84, unpriced: 0, cacheRead: 3_600_000, input: 4_000_000 }} />);
  const chip = el.querySelector(".tag.cost")!;
  expect(chip.textContent).toBe("412k · ~$1.84");
  expect(chip.getAttribute("title")).toContain("90% of what the agents read came from the prompt cache.");
  expect(chip.getAttribute("title")).toContain("list prices");
});
