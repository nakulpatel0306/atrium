import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NeedsPage, visibleRange, ROW_PX } from "../../src/dashboard/components/NeedsPage";
import { cleanReviews, itemLine, itemTitle, queueOf } from "../../src/dashboard/queue";
import { newLoop, SIZE_BUDGETS, type LoopState } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import { ids, makeState, task } from "../tui/fixtures";

type Approval = State["approvals"][number];
let calls: { url: string; body: unknown }[] = [];
let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/checks")) return Response.json([]);
    if (url.endsWith("/batch")) return Response.json({ approved: [], skipped: [] });
    if (url.includes("/outputs")) return Response.json({ files: [], summary: null });
    return Response.json({});
  }) as typeof fetch;
});
afterEach(async () => {
  // Lets the fetches the panel started settle inside act, before the DOM goes away.
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
const press = async (key: string, init: KeyboardEventInit = {}) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));

const now = Date.now();
const min = 60_000;
const clean: Partial<LoopState> = { stage: "ready", checks: "passed", reviews: [{ reviewer: "claude", verdict: "approve", findings: [], skipped: null }] };
const review = (id: string, taskId: string, ago: number): Approval => ({ ...makeState().approvals[0]!, id, taskId, title: `Review ${taskId}`, createdAt: now - ago * min });

// Two clean results, one with a note, a paused task and a CLAUDE.md proposal, waiting different lengths of time.
function queueState(): State {
  const s = makeState();
  const repo = s.spaces.find((x) => x.kind === "repo")!;
  const result = (id: string, loop: Partial<LoopState>) => task({ id, spaceId: repo.id, title: id, status: "review", outcome: "done", loop: { ...newLoop(SIZE_BUDGETS.small), ...loop } });
  return {
    ...s,
    proposals: [],
    approvals: [review("apr_a", "tsk_a", 5), review("apr_b", "tsk_b", 30), review("apr_c", "tsk_c", 60)],
    tasks: [
      result("tsk_a", clean),
      result("tsk_b", clean),
      result("tsk_c", { ...clean, attention: ["The change edits check config: bunfig.toml."] }),
      task({ id: "tsk_p", spaceId: repo.id, title: "Ranking", status: "blocked", updatedAt: now - 90 * min, loop: { ...newLoop(SIZE_BUDGETS.small), paused: { kind: "budget", diagnosis: "Another turn would go over the budget." } } }),
    ],
    learning: { ...s.learning, memory: [{ id: "mem_1", spaceId: repo.id, taskId: null, source: "steer", line: "Use the wait() helper in tests.", why: "You steered.", status: "open", branch: null, commitSha: null, createdAt: now - 500 * min }] },
  };
}

test("the queue runs longest-blocked first, low-priority items last, and counts only what holds something up", () => {
  const s = queueState();
  expect(queueOf(s).map((i) => i.key)).toEqual(["tsk_p", "apr_c", "apr_b", "apr_a", "mem_1"]);
  expect(itemTitle(s, queueOf(s)[0]!)).toBe("Ranking");
  expect(itemLine(s, queueOf(s)[0]!)).toBe("Another turn would go over the budget.");
  const el = render(<NeedsPage state={s} />);
  expect(el.querySelector("h1")!.textContent).toBe("Needs you · 4");
  expect([...el.querySelectorAll(".q-row")].map((r) => r.id)).toEqual(["q-tsk_p", "q-apr_c", "q-apr_b", "q-apr_a", "q-mem_1"]);
});

test("j and k move the selection and the decision beside it follows; a and s press the open item's own buttons", async () => {
  const el = render(<NeedsPage state={queueState()} />);
  const title = () => el.querySelector("#dp-title")!.textContent;
  expect(title()).toBe("Ranking");
  await press("j");
  expect(title()).toBe("Review tsk_c");
  // A result with a note gets the quieter "Approve anyway".
  expect(el.querySelector('[data-act="approve"]')!.textContent).toBe("Approve anyway");
  await press("j");
  expect(title()).toBe("Review tsk_b");
  await press("a");
  expect(calls.at(-1)).toEqual({ url: "/api/approvals/apr_b", body: { decision: "approve" } });
  await press("k");
  await press("s");
  expect(el.querySelector('input[aria-label="What should change?"]')).not.toBeNull();
});

test("e asks a paused task for the diagnosis; ? shows the keys", async () => {
  const el = render(<NeedsPage state={queueState()} />);
  await press("e");
  expect(calls.at(-1)!.url).toBe("/api/tasks/tsk_p/explain");
  await press("?");
  expect(el.querySelector(".keys-sheet")!.textContent).toContain("Approve every clean result at once");
  await press("Escape");
  expect(el.querySelector(".keys-sheet")).toBeNull();
});

test("batch approval offers only the clean results, and Shift A opens it", async () => {
  const s = queueState();
  expect(cleanReviews(s).map((i) => i.key)).toEqual(["apr_b", "apr_a"]);
  const el = render(<NeedsPage state={s} />);
  await press("A");
  const sheet = el.querySelector(".batch-sheet")!;
  expect([...sheet.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Review tsk_b", "Review tsk_a"]);
  await act(async () => [...sheet.querySelectorAll("button")].find((b) => b.textContent === "Approve all 2")!.click());
  expect(calls.at(-1)).toEqual({ url: "/api/approvals/batch", body: { ids: ["apr_b", "apr_a"] } });
});

test("an empty queue says so", () => {
  const s = makeState({ approvals: [], proposals: [], tasks: [] });
  expect(render(<NeedsPage state={s} />).textContent).toContain("You're all caught up.");
});

test("a long queue draws only the rows in view, within a render budget", () => {
  const s = makeState();
  const many = Array.from({ length: 2000 }, (_, i) => review(`apr_${i}`, ids.review, 2000 - i));
  const big = { ...s, approvals: many, proposals: [] };
  expect(visibleRange(0, 800, 2000)).toEqual([0, Math.ceil(800 / ROW_PX) + 24]);
  expect(visibleRange(100 * ROW_PX, 800, 2000)[0]).toBe(88);
  const started = performance.now();
  const el = render(<NeedsPage state={big} />);
  const ms = performance.now() - started;
  expect(el.querySelectorAll(".q-row").length).toBeLessThan(80);
  // Generous for a slow CI machine; a full 2,000-row render takes several times this.
  expect(ms).toBeLessThan(400);
});
