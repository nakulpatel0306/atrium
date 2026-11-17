import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LiveRegion } from "../../src/dashboard/components/LiveRegion";
import { NeedsList } from "../../src/dashboard/components/NeedsYou";
import { NeedsPage, visibleRange, ROW_PX } from "../../src/dashboard/components/NeedsPage";
import { attentionQueue, cleanReviews, itemLine, itemTitle } from "../../src/dashboard/queue";
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
    if (url.includes("/diff")) return Response.json({ files: [], totals: { files: 0, additions: 0, deletions: 0 }, truncated: false });
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
// The label a button shows: a risky Approve stacks every label it can take and shows one.
const shown = (b: Element) => (b.querySelector(".btn-labels .on") ?? b).textContent;
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
      result("tsk_a", { ...clean, checkedSha: "sha_a" }),
      result("tsk_b", { ...clean, checkedSha: "sha_b" }),
      result("tsk_c", { ...clean, attention: ["The change edits check config: bunfig.toml."] }),
      task({ id: "tsk_p", spaceId: repo.id, title: "Ranking", status: "blocked", updatedAt: now - 90 * min, loop: { ...newLoop(SIZE_BUDGETS.small), paused: { kind: "budget", diagnosis: "Another turn would go over the budget." } } }),
    ],
    learning: { ...s.learning, memory: [{ id: "mem_1", spaceId: repo.id, taskId: null, source: "steer", line: "Use the wait() helper in tests.", why: "You steered.", status: "open", branch: null, commitSha: null, createdAt: now - 500 * min }] },
  };
}

test("the queue runs longest-blocked first, low-priority items last, and counts only what holds something up", () => {
  const s = queueState();
  expect(attentionQueue(s).map((i) => i.key)).toEqual(["tsk_p", "apr_c", "apr_b", "apr_a", "mem_1"]);
  expect(itemTitle(s, attentionQueue(s)[0]!)).toBe("Ranking");
  expect(itemLine(s, attentionQueue(s)[0]!)).toBe("Another turn would go over the budget.");
  const el = render(<NeedsPage state={s} />);
  expect(el.querySelector("h1")!.textContent).toBe("Needs you · 4");
  expect([...el.querySelectorAll(".q-row")].map((r) => r.id)).toEqual(["q-tsk_p", "q-apr_c", "q-apr_b", "q-apr_a", "q-mem_1"]);
});

test("j and k move the selection and the decision beside it follows; a and s press the open item's own buttons", async () => {
  const el = render(<NeedsPage state={queueState()} />);
  const title = () => el.querySelector("#dp-title")!.textContent;
  expect(title()).toBe("Ranking");
  // A paused item's screen leads with why it paused, and its time reads as the row's does.
  expect(el.querySelector(".dp-lead")!.textContent).toBe("Paused: Another turn would go over the budget.");
  expect(el.querySelector(".dp-meta")!.textContent).toContain("waiting 1h");
  expect(el.querySelector("#q-tsk_p time")!.textContent).toBe("1h");
  await press("j");
  expect(title()).toBe("Review tsk_c");
  // A result with a note gets the quieter "Approve anyway", and the key asks twice.
  expect(shown(el.querySelector('[data-act="approve"]')!)).toBe("Approve anyway");
  const decided = () => calls.filter((c) => c.url.startsWith("/api/approvals/")).length;
  await press("a");
  expect(decided()).toBe(0);
  // The button itself asks for the second press; the key line under it says how to back out.
  expect(shown(el.querySelector('[data-act="approve"]')!)).toBe("Press a again to approve");
  expect(el.querySelector(".decision-keys.armed")!.textContent).toContain("Esc cancels");
  await press("a");
  expect(calls.at(-1)).toEqual({ url: "/api/approvals/apr_c", body: { decision: "approve" } });
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

test("a budget pause raises its budget and carries on in one click, and Change budget is a real button", async () => {
  const s = queueState();
  const spent = { ...s, tasks: s.tasks.map((t) => (t.id === "tsk_p" ? { ...t, loop: { ...t.loop!, usage: { tokens: 210_000, ms: 60_000, unreported: false } } } : t)) };
  const el = render(<NeedsPage state={spent} item="tsk_p" />);
  const raise = [...el.querySelectorAll<HTMLButtonElement>(".paused button")].find((b) => b.textContent === "Raise to 400k tokens and carry on")!;
  expect(raise.className).toBe("btn");
  await act(async () => raise.click());
  expect(calls.at(-1)).toEqual({ url: "/api/tasks/tsk_p/budget", body: { budget: { tokens: 400_000, minutes: 20 }, resume: true } });
  const change = [...el.querySelectorAll<HTMLButtonElement>(".budget button")].find((b) => b.textContent === "Change budget")!;
  expect(change.className).toBe("btn");
  await act(async () => change.click());
  const save = [...el.querySelectorAll<HTMLButtonElement>(".budget button")].find((b) => b.type === "submit")!;
  expect(save.textContent).toBe("Save and carry on");
  await act(async () => save.click());
  expect(calls.at(-1)!.body).toMatchObject({ resume: true });
});

test("the address follows the item on screen, so a reload lands on the same one", async () => {
  render(<NeedsPage state={queueState()} />);
  expect(location.search).toBe("?item=tsk_p");
  await press("j");
  expect(location.search).toBe("?item=apr_c");
});

test("a result's stepper ends on its verdict, and a list's icon warns when it Needs a look", async () => {
  const { StatusIcon } = await import("../../src/dashboard/components/StatusIcon");
  const el = render(<NeedsPage state={queueState()} item="apr_a" />);
  expect(el.querySelector(".stages li.on")!.textContent).toBe("Clean");
  act(() => root!.unmount());
  const icon = render(<StatusIcon status="review" look />);
  expect(icon.querySelector("[aria-label]")!.getAttribute("aria-label")).toBe("Needs a look");
});

test("the queue lists a result by its verdict, the word Home and its space use", () => {
  const el = render(<NeedsPage state={queueState()} />);
  expect(el.querySelector("#q-apr_c .q-kind")!.textContent).toBe("Needs a look");
  expect(el.querySelector("#q-apr_a .q-kind")!.textContent).toBe("Clean");
  expect(el.querySelector("#q-tsk_p .q-kind")!.textContent).toBe("Paused");
});

test("Home's result rows carry one status chip and the cost, and say what's going on in one line", () => {
  const s = queueState();
  s.spend.tasks = { tsk_a: { weighted: 41_000, usd: 0.04, unpriced: 0, cacheRead: 0, input: 0 } };
  const el = render(<NeedsList state={s} />);
  const row = (title: string) => [...el.querySelectorAll(".summary-row")].find((r) => r.querySelector(".t")!.textContent!.startsWith(title))!;
  const noted = row("Review tsk_c");
  expect([...noted.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["Needs a look"]);
  // The rest is in the chip's tooltip and on the item's screen.
  expect(noted.querySelector(".chip")!.getAttribute("title")).toContain("bunfig.toml");
  expect(noted.querySelector(".t span")!.textContent).toBe("Approved by Claude · Checks passed");
  const clean = row("Review tsk_a");
  expect([...clean.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["Clean"]);
  expect(clean.querySelector(".tag.cost")!.textContent).toBe("~$0.04");
});

test("batch approval offers only the clean results, and Shift A opens it", async () => {
  const s = queueState();
  expect(cleanReviews(s).map((i) => i.key)).toEqual(["apr_b", "apr_a"]);
  const el = render(<NeedsPage state={s} />);
  await press("A");
  const sheet = el.querySelector(".batch-sheet")!;
  expect([...sheet.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Review tsk_b", "Review tsk_a"]);
  await act(async () => [...sheet.querySelectorAll("button")].find((b) => b.textContent === "Approve all 2")!.click());
  expect(calls.at(-1)).toEqual({ url: "/api/approvals/batch", body: { items: [{ id: "apr_b", sha: "sha_b" }, { id: "apr_a", sha: "sha_a" }] } });
});

test("a result the agent didn't say it finished is risky too, so it never approves on one key", async () => {
  const { isRisky } = await import("../../src/dashboard/queue");
  const s = queueState();
  const unclear = { ...s, tasks: s.tasks.map((t) => (t.id === "tsk_a" ? { ...t, outcome: "unknown" as const } : t)) };
  expect(isRisky(unclear, unclear.approvals.find((a) => a.id === "apr_a")!)).toBe(true);
  expect(isRisky(s, s.approvals.find((a) => a.id === "apr_a")!)).toBe(false);
});

test("approving a result on a branch sends the commit its screen shows", async () => {
  const s = queueState();
  const onBranch = { ...s, tasks: s.tasks.map((t) => (t.id === "tsk_a" ? { ...t, branch: "atrium/tsk_a" } : t)) };
  render(<NeedsPage state={onBranch} item="apr_a" />);
  await press("a");
  expect(calls.find((c) => c.url === "/api/approvals/apr_a")!.body).toEqual({ decision: "approve", sha: "sha_a" });
});

test("on a narrow window, a key never presses a decision the list is hiding", async () => {
  render(<NeedsPage state={queueState()} item="apr_a" />);
  const panel = document.querySelector<HTMLElement>(".q-panel")!;
  panel.style.display = "none";
  await press("a");
  expect(calls.some((c) => c.url.startsWith("/api/approvals/"))).toBe(false);
  panel.style.display = "";
  await press("a");
  expect(calls.some((c) => c.url.startsWith("/api/approvals/"))).toBe(true);
});

test("a risky result leads with why it needs a look, and its keys say a second a approves anyway", () => {
  const el = render(<NeedsPage state={queueState()} item="apr_c" />);
  const points = el.querySelector(".open-points")!;
  expect(points.querySelector("h4")!.textContent).toBe("Why");
  // The bar above it doesn't say Needs a look a third time.
  expect(el.querySelector(".dp-acts .chip.waiting")).toBeNull();
  expect(points.textContent).toContain("The change edits check config: bunfig.toml.");
  // Before the walkthrough and the diff, right under the decision.
  expect(el.querySelector(".dp-acts")!.nextElementSibling).toBe(points);
  expect(el.querySelector(".decision-keys")!.textContent).toContain("a twice: approve anyway");
  expect(el.querySelector(".q-kind.risky")).not.toBeNull();
});

test("a risky result takes two clicks too: the first arms Approve, the second approves", async () => {
  const el = render(<NeedsPage state={queueState()} item="apr_c" />);
  const button = () => el.querySelector<HTMLButtonElement>('.dp-acts [data-act="approve"]')!;
  await act(async () => button().click());
  expect(calls.some((c) => c.url === "/api/approvals/apr_c")).toBe(false);
  expect(shown(button())).toBe("Click again to approve");
  await act(async () => button().click());
  expect(calls.find((c) => c.url === "/api/approvals/apr_c")!.body).toMatchObject({ decision: "approve" });
});

test("the first a on a risky result relabels Approve in place and says so; Esc or moving away disarms it", async () => {
  const el = render(
    <>
      <LiveRegion />
      <NeedsPage state={queueState()} item="apr_c" />
    </>,
  );
  const button = () => el.querySelector<HTMLButtonElement>('.dp-acts [data-act="approve"]')!;
  const labels = () => [...button().querySelectorAll(".btn-labels > span")].map((x) => x.textContent);
  const before = labels();
  await press("a");
  expect(shown(button())).toBe("Press a again to approve");
  expect(el.querySelector('[aria-live="polite"]')!.textContent).toBe("Press a again to approve.");
  // Every label was already in the button, so its width is the longest one's before and after: nothing shifts.
  expect(labels()).toEqual(before);
  expect(el.querySelector(".decision-keys")!.className).toContain("armed");
  await press("Escape");
  expect(shown(button())).toBe("Approve anyway");
  expect(el.querySelector(".decision-keys.armed")).toBeNull();
  expect(el.querySelector('[aria-live="polite"]')!.textContent).toBe("Cancelled. Approve takes two presses again.");
  // A second a after Esc arms again rather than approving.
  await press("a");
  expect(calls.some((c) => c.url === "/api/approvals/apr_c")).toBe(false);
  await press("j");
  await press("k");
  expect(shown(button())).toBe("Approve anyway");
  expect(calls.some((c) => c.url === "/api/approvals/apr_c")).toBe(false);
});

test("a result on a branch shows its diff right in the queue", async () => {
  const s = queueState();
  const onBranch = { ...s, tasks: s.tasks.map((t) => (t.id === "tsk_a" ? { ...t, branch: "atrium/tsk_a" } : t)) };
  const el = render(<NeedsPage state={onBranch} item="apr_a" />);
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(calls.some((c) => c.url === "/api/tasks/tsk_a/diff")).toBe(true);
  expect(el.querySelector(".dp .changes-section")).not.toBeNull();
});

test("a result with no changes says so plainly and offers no diff", () => {
  const s = queueState();
  const empty = { ...s, tasks: s.tasks.map((t) => (t.id === "tsk_a" ? { ...t, outcome: "unknown" as const, loop: { ...t.loop!, noChanges: true } } : t)) };
  const el = render(<NeedsPage state={empty} item="apr_a" />);
  expect(el.querySelector(".dp-lead")!.textContent).toBe("It made no changes: its branch holds nothing new.");
  expect(el.querySelector(".changes-section")).toBeNull();
  expect(el.textContent).not.toContain("can't tell");
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
