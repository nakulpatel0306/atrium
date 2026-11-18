import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NeedsPage } from "../../src/dashboard/components/NeedsPage";
import { LiveRegion } from "../../src/dashboard/components/LiveRegion";
import { SpaceView } from "../../src/dashboard/components/SpaceView";
import { newLoop, SIZE_BUDGETS, type LoopState } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import { ids, makeState, task } from "../tui/fixtures";

let calls: { url: string; body: unknown }[] = [];
let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/checks")) return Response.json([{ id: 1, name: "Tests", command: "bun test", status: "failed", durationMs: 1200, output: "1 fail: expected 10, got 15" }]);
    if (url.includes("/diff")) return Response.json({ files: [], totals: { files: 0, additions: 0, deletions: 0 }, truncated: false, turns: [] });
    if (url.includes("/outputs")) return Response.json({ files: [], summary: null });
    if (url.includes("/files")) return Response.json({ files: [] });
    return Response.json({});
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

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  return el;
}

// A result that needs a look: failing checks, an attention note, a finding the writer declined, a brief and a retro.
function riskyState(): State {
  const s = makeState();
  const loop: LoopState = {
    ...newLoop(SIZE_BUDGETS.small),
    stage: "ready",
    checks: "failed",
    checkedSha: "sha_1",
    attention: ["The change edits check config: bunfig.toml."],
    reviews: [
      {
        reviewer: "codex",
        verdict: "changes",
        skipped: null,
        findings: [{ severity: "medium", file: "src/cart.ts", line: 12, reason: "The coupon can go over 100%.", resolution: { action: "declined", note: "Capped elsewhere." } }],
      },
    ],
  };
  return {
    ...s,
    tasks: s.tasks.map((t) => (t.id === ids.review ? { ...t, outcome: "done" as const, brief: { goal: "Fix the redirect after login.", acceptance: ["Lands on the page it came from"], verify: "auto", scope: "", nonGoals: [], lookFirst: [], size: "small" as const, answers: [] }, loop } : t)),
    learning: { ...s.learning, retros: { [ids.review]: { lines: ["You steered once.", "One rework turn.", "Add acceptance criteria next time."] } } },
  };
}

// The evidence a decision shows, by section, in the order it shows them.
const evidence = (el: Element) =>
  [".dp-acts", ".open-points", ".walkthrough, .walkthrough-empty", ".changes-section", ".brief-view", ".check-rows", ".review-round", ".budget", ".retro"].filter((sel) => el.querySelector(sel));

test("a task page shows a result's decision with the same evidence as its screen in Needs you", async () => {
  const s = riskyState();
  const space = s.spaces.find((x) => x.id === ids.atrium)!;
  const queue = await render(<NeedsPage state={s} item={ids.approval} />);
  const inQueue = evidence(queue.querySelector(".dp")!);
  act(() => root!.unmount());
  document.body.replaceChildren();
  const page = await render(<SpaceView state={s} space={space} focusTask={ids.review} />);
  const onPage = evidence(page.querySelector(".task-decision")!);
  expect(inQueue).toEqual([".dp-acts", ".open-points", ".walkthrough, .walkthrough-empty", ".changes-section", ".brief-view", ".check-rows", ".review-round", ".budget", ".retro"]);
  expect(onPage).toEqual(inQueue);
  // The failing output is open on both, and the reasons are said once, above the diff.
  expect(page.querySelector(".check-rows")!.textContent).toContain("expected 10, got 15");
  expect(page.querySelectorAll(".open-points").length).toBe(1);
  // The diff isn't behind a tab any more, and isn't shown twice.
  expect(page.querySelectorAll(".changes-section").length).toBe(1);
  expect(page.querySelector(".work-tabs")).toBeNull();
  // The row wears the verdict, once, as the queue does, and the decision leads with where the task is.
  const tags = [...page.querySelectorAll(`#task-${ids.review} .task-open .tag`)].map((t) => t.textContent);
  expect(tags).toEqual(["needs a look"]);
  expect(page.querySelector(".task-decision")!.firstElementChild!.className).toBe("stages");
});

const press = async (key: string, init: KeyboardEventInit = {}) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })));
const decided = () => calls.filter((c) => c.url.startsWith("/api/approvals/"));
const said = (el: Element) => el.querySelector('[aria-live="polite"]')!.textContent;
const shown = (b: Element) => (b.querySelector(".btn-labels .on") ?? b).textContent;

async function page(s: State, focusTask: string | null = ids.review) {
  const space = s.spaces.find((x) => x.id === ids.atrium)!;
  return render(
    <>
      <LiveRegion />
      <SpaceView state={s} space={space} focusTask={focusTask} />
    </>,
  );
}

test("on a task page, a approves the open result and s sends it back, as in Needs you", async () => {
  const s = makeState();
  s.tasks = s.tasks.map((t) => (t.id === ids.review ? { ...t, loop: { ...newLoop(SIZE_BUDGETS.small), stage: "ready", checks: "passed", checkedSha: "sha_ok", reviews: [{ reviewer: "codex", verdict: "approve", findings: [], skipped: null }] }, outcome: "done" } : t));
  const el = await page(s);
  expect(el.querySelector(".task-decision .decision-keys")!.textContent).toContain("? all keys");
  await press("s");
  expect(el.querySelector('input[aria-label="What should change?"]')).not.toBeNull();
  await press("a");
  expect(decided()).toEqual([{ url: `/api/approvals/${ids.approval}`, body: { decision: "approve", sha: "sha_ok" } }]);
});

test("on a task page, the first a on a risky result relabels Approve; Esc disarms it; the second a approves", async () => {
  const el = await page(riskyState());
  const button = () => el.querySelector<HTMLButtonElement>('.task-decision [data-act="approve"]')!;
  await press("a");
  expect(decided()).toEqual([]);
  expect(shown(button())).toBe("Press a again to approve");
  expect(said(el)).toBe("Press a again to approve.");
  await press("Escape");
  expect(shown(button())).toBe("Approve anyway");
  await press("a");
  await press("a");
  expect(decided().map((c) => c.url)).toEqual([`/api/approvals/${ids.approval}`]);
});

test("x asks to stop an open running task, and e asks an open paused one for the diagnosis", async () => {
  const s = makeState();
  s.tasks.push(task({ id: "tsk_paused", spaceId: ids.atrium, title: "Ranking", status: "blocked", loop: { ...newLoop(SIZE_BUDGETS.small), paused: { kind: "budget", diagnosis: "Another turn would go over the budget." } } }));
  const running = await page(s, ids.running);
  await press("x");
  expect(running.querySelector('[data-act="stop-confirm"]')).not.toBeNull();
  act(() => root!.unmount());
  document.body.replaceChildren();
  await page(s, "tsk_paused");
  await press("e");
  expect(calls.some((c) => c.url === "/api/tasks/tsk_paused/explain")).toBe(true);
});

test("a decision that's hidden ignores the keys, and says why", async () => {
  // A closed row shows no decision at all.
  const closed = await page(riskyState(), null);
  await press("a");
  await press("a");
  expect(decided()).toEqual([]);
  expect(said(closed)).toBe("Nothing open here to approve. Open a task that's ready for review.");
  act(() => root!.unmount());
  document.body.replaceChildren();
  // An open row whose decision is hidden (a narrow layout, say) is the same: a key never presses what can't be seen.
  const s = makeState();
  s.tasks = s.tasks.map((t) => (t.id === ids.review ? { ...t, outcome: "done" } : t));
  const el = await page(s);
  el.querySelector<HTMLElement>(".task-decision")!.style.display = "none";
  await press("a");
  await press("s");
  expect(decided()).toEqual([]);
  expect(el.querySelector('input[aria-label="What should change?"]')).toBeNull();
  el.querySelector<HTMLElement>(".task-decision")!.style.display = "";
  await press("a");
  expect(decided().length).toBe(1);
});

test("with two open results, a key waits for the user to pick one rather than guess", async () => {
  const s = makeState();
  s.tasks.push(task({ id: "tsk_two", spaceId: ids.atrium, title: "Second", status: "review", outcome: "done" }));
  s.approvals.push({ ...s.approvals[0]!, id: "apr_two", taskId: "tsk_two", title: "Review: Second" });
  const el = await page(s);
  await act(async () => el.querySelector<HTMLButtonElement>("#task-tsk_two .task-open")!.click());
  await act(async () => (document.activeElement as HTMLElement | null)?.blur());
  await press("a");
  expect(decided()).toEqual([]);
  expect(said(el)).toContain("More than one open task");
  // Focus inside one of them picks it.
  el.querySelector<HTMLButtonElement>("#task-tsk_two .task-open")!.focus();
  await press("a");
  expect(decided().map((c) => c.url)).toEqual(["/api/approvals/apr_two"]);
});

test("? lists the keys that work on a space's page, and keys are ignored while typing", async () => {
  const el = await page(makeState());
  await press("?");
  const sheet = el.querySelector(".keys-sheet")!;
  expect([...sheet.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["a", "s", "x", "e", "z", "Esc", "?"]);
  expect(sheet.textContent).not.toContain("Next / previous item");
  await press("Escape");
  expect(el.querySelector(".keys-sheet")).toBeNull();
  const input = document.createElement("input");
  document.body.appendChild(input);
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
  expect(decided()).toEqual([]);
  await press("a");
  expect(decided().length).toBe(1);
});

test("a question task is called a Question in the palette, and its space's Live box answers it in place", async () => {
  const { paletteActions } = await import("../../src/dashboard/palette");
  const s = makeState();
  const loop = { ...newLoop(SIZE_BUDGETS.small), stage: "brief" as const, questions: [{ question: "Weekly or daily?", options: ["Weekly", "Daily"] }] };
  // Another agent is running: the questions are still answered from Live.
  s.tasks.push(task({ id: "tsk_ask", spaceId: ids.atrium, title: "Export totals", status: "queued", loop, brief: { goal: "Totals", acceptance: [], verify: "auto", scope: "", nonGoals: [], lookFirst: [], size: "small", answers: [] } }));
  s.waits = { tsk_ask: { taskId: "tsk_ask", agent: "claude", kind: "answers", reason: "The brief has questions for you, in Needs you." } };
  expect(paletteActions(s, { spaceId: null, theme: "system" }).find((a) => a.id === "task-tsk_ask")!.hint).toBe("atrium · Question");
  const el = await page(s, null);
  const live = el.querySelector("div.live")!;
  expect(live.querySelector(".live-ask")!.textContent).toContain("Weekly or daily?");
  await act(async () => [...live.querySelectorAll<HTMLButtonElement>(".brief-q button")].find((b) => b.textContent === "Weekly")!.click());
  await act(async () => [...live.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Answer")!.click());
  expect(calls.filter((c) => c.url === "/api/tasks/tsk_ask/answers").at(-1)).toEqual({ url: "/api/tasks/tsk_ask/answers", body: { answers: [{ question: "Weekly or daily?", answer: "Weekly" }] } });
});

test("a brief's questions show in one form: the task's row when it's open, else Live", async () => {
  const s = makeState();
  const loop = { ...newLoop(SIZE_BUDGETS.small), stage: "brief" as const, questions: [{ question: "Weekly or daily?", options: ["Weekly", "Daily"] }] };
  s.tasks.push(task({ id: "tsk_ask", spaceId: ids.atrium, title: "Export totals", status: "queued", loop, brief: { goal: "Totals", acceptance: [], verify: "auto", scope: "", nonGoals: [], lookFirst: [], size: "small", answers: [] } }));
  const closed = await page(s, null);
  expect([closed.querySelectorAll(".brief-qs").length, closed.querySelectorAll(".live .brief-qs").length]).toEqual([1, 1]);
  act(() => root!.unmount());
  document.body.replaceChildren();
  const opened = await page(s, "tsk_ask");
  expect([opened.querySelectorAll(".brief-qs").length, opened.querySelectorAll(".live .brief-qs").length]).toEqual([1, 0]);
});

test("on a task page, decision keys do nothing while the keys sheet is open", async () => {
  const s = makeState();
  s.tasks = s.tasks.map((t) => (t.id === ids.review ? { ...t, outcome: "done" } : t));
  const el = await page(s);
  await press("?");
  await press("a");
  expect(decided()).toEqual([]);
  expect(said(el)).toContain("The keys sheet is open.");
  await press("?");
  await press("a");
  expect(decided().length).toBe(1);
});
