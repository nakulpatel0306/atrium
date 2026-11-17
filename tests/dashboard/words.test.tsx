import { raiseFirst } from "../../src/engine/loop";
import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NeedsList } from "../../src/dashboard/components/NeedsYou";
import { DecisionPanel } from "../../src/dashboard/components/NeedsPage";
import { attentionQueue, KIND_TEXT, type QueueItem } from "../../src/dashboard/queue";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import { BUDGET_STEP, goTo, KIND, TASK_WORD } from "../../src/engine/words";
import { STATUS_TEXT } from "../../src/dashboard/summary";
import { deriveView } from "../../src/tui/select";
import { cardsOf } from "../../src/tui/screens/home";
import { paletteActions } from "../../src/dashboard/palette";
import { initialUi } from "../../src/tui/ui";
import { ids, makeState, proposal, task } from "../tui/fixtures";

let root: Root | null = null;
let posted: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  posted = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(url);
    if (url.endsWith("/checks")) return Response.json([]);
    if (url.includes("/diff")) return Response.json({ files: [], totals: { files: 0, additions: 0, deletions: 0 }, truncated: false });
    if (url.includes("/outputs")) return Response.json({ files: [], summary: null });
    if (url.includes("/memory")) return Response.json({ path: "CLAUDE.md", exists: true, lines: [] });
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

function render(node: React.ReactNode): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(node));
  return el;
}

// One of every kind in the queue: a review, a sign-off, a question, a pause, a suggestion, a CLAUDE.md line and a yes
// held before it starts.
function everyKind(): State {
  const s = makeState();
  const now = Date.now();
  const signOff = { ...s.approvals[0]!, id: "apr_signoff", taskId: null, spaceId: null, kind: "create_repo" as State["approvals"][number]["kind"], title: 'Create GitHub repo "demo"?', detail: "A new private repo." };
  return {
    ...s,
    approvals: [...s.approvals, signOff],
    held: [{ id: "apr_held", spaceId: null, title: "Remove the local copy of fakeuser/demo?", approvedAt: now - 10_000, startsAt: now + 50_000 }],
    proposals: [proposal()],
    tasks: [
      ...s.tasks,
      task({ id: "tsk_asks", spaceId: ids.atrium, title: "Add totals", status: "queued", loop: { ...newLoop(SIZE_BUDGETS.small), stage: "brief", questions: [{ question: "Weekly or monthly?", options: ["Weekly", "Monthly"] }] } }),
      task({ id: "tsk_paused", spaceId: ids.atrium, title: "Ranking", status: "blocked", loop: { ...newLoop(SIZE_BUDGETS.small), paused: { kind: "budget", diagnosis: "Another turn would go over the budget.", at: now } } }),
    ],
    learning: { ...s.learning, memory: [{ id: "mem_1", spaceId: ids.atrium, taskId: null, source: "steer", line: "Use the wait() helper.", why: "You steered.", status: "open", branch: null, commitSha: null, createdAt: now }] },
  };
}

const kindsOf = (items: QueueItem[]) => new Set(items.map((i) => i.kind));

test("the fixture covers each kind the surfaces decide on", () => {
  expect([...kindsOf(attentionQueue(everyKind()))].sort()).toEqual(["approval", "memory", "paused", "question", "review", "starting", "suggestion"]);
});

test("the queue's labels and the task words come from the shared map", () => {
  for (const [kind, { label }] of Object.entries(KIND)) expect(KIND_TEXT[kind as keyof typeof KIND]).toBe(label);
  expect(STATUS_TEXT.blocked).toBe(TASK_WORD.stopped);
  expect(STATUS_TEXT.review).toBe(TASK_WORD.review);
});

test("Home's summary rows: each item's tag is its label and its one button names its step", () => {
  const s = everyKind();
  const el = render(<NeedsList state={s} />);
  const rows = [...el.querySelectorAll<HTMLElement>(".summary-row")];
  const items = attentionQueue(s);
  expect(rows).toHaveLength(items.length);
  items.forEach((item, i) => {
    // At most one status chip, beside the cost: a result's Needs a look or Clean, and every other row its kind's label.
    const tag = rows[i]!.querySelector(".tag:not(.cost)");
    const chips = rows[i]!.querySelectorAll(".chip");
    expect(chips.length + (tag ? 1 : 0)).toBeLessThanOrEqual(1);
    if (chips.length) expect(tag).toBeNull();
    else expect(tag!.textContent).toBe(KIND[item.kind].label);
    expect(rows[i]!.querySelectorAll(".tag.cost").length).toBeLessThanOrEqual(1);
    const buttons = [...rows[i]!.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    const budget = s.tasks.find((t) => t.id === item.taskId)?.loop?.paused?.kind === "budget";
    expect(buttons[0]!.textContent).toBe(goTo(item.kind, budget));
  });
  // Low-priority items sit under their own divider, so the heading's count is the rows above it.
  const order = [...el.querySelector(".needs-list")!.children].map((c) => (c.classList.contains("low-head") ? "divider" : "row"));
  expect(order.indexOf("divider")).toBe(items.filter((i) => !i.low).length);
  // Nothing is decided from a summary.
  expect(el.querySelector('[data-act="approve"], [data-act="send-back"]')).toBeNull();
});

test("each decision screen's primary button is the step its rows named", () => {
  const s = everyKind();
  for (const item of attentionQueue(s)) {
    const el = render(<DecisionPanel item={item} state={s} />);
    expect(el.querySelector(".q-kind")!.textContent).toBe(KIND[item.kind].label);
    const primary = [...el.querySelectorAll<HTMLButtonElement>(".dp-body .btn.p")].map((b) => b.textContent);
    // A budget pause leads with raising the budget, the step its row names.
    const budget = s.tasks.find((t) => t.id === item.taskId)?.loop?.paused?.kind === "budget";
    if (budget) expect(primary.some((p) => p?.startsWith("Raise to"))).toBe(true);
    else expect(primary).toContain(KIND[item.kind].action);
    act(() => root!.unmount());
    root = null;
  }
});

test("the terminal app's cards say each label and offer the same step as their main key", () => {
  const s = everyKind();
  const view = deriveView(s, initialUi);
  const cards = cardsOf(view, Date.now(), 80);
  for (const item of view.queue) {
    const card = cards.find((c) => c.id === item.key)!;
    expect(card.meta.map((m) => m.text).join("")).toContain(KIND[item.kind].label);
    // A budget pause's first step is raising it, in the shared words; everything else leads with its kind's step.
    const budget = item.kind === "paused" && raiseFirst(s.tasks.find((t) => t.id === item.key)?.loop);
    expect(card.keys.find((k) => k.hot)!.label).toBe(budget ? BUDGET_STEP : KIND[item.kind].action);
  }
});

test("the palette names a task's state in the shared words, never the raw status", () => {
  const s = everyKind();
  const hint = (id: string) => paletteActions(s, { spaceId: null, theme: "system" }).find((a) => a.id === `task-${id}`)!.hint;
  expect(hint("tsk_paused")).toBe("atrium · Paused");
  expect(hint(ids.blocked)).toBe("job hunt · Stopped");
});

test("a held yes is in the list as starting, and its Undo takes it back", async () => {
  const s = everyKind();
  const item = attentionQueue(s).find((i) => i.kind === "starting")!;
  expect(item.low).toBe(true);
  const el = render(<DecisionPanel item={item} state={s} />);
  expect(el.textContent).toContain("unless you take it back");
  await act(async () => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Undo")!.click());
  expect(posted).toContain("/api/approvals/apr_held/reopen");
});
