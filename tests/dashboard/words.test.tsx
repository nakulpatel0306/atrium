import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NeedsList } from "../../src/dashboard/components/NeedsYou";
import { DecisionPanel } from "../../src/dashboard/components/NeedsPage";
import { attentionQueue, KIND_TEXT, type QueueItem } from "../../src/dashboard/queue";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import { goTo, KIND, TASK_WORD } from "../../src/engine/words";
import { STATUS_TEXT } from "../../src/dashboard/summary";
import { deriveView } from "../../src/tui/select";
import { cardsOf } from "../../src/tui/screens/home";
import { initialUi } from "../../src/tui/ui";
import { ids, makeState, proposal, task } from "../tui/fixtures";

let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (url: string) => {
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

// One of every kind that waits on you: a review, a sign-off, a question, a pause, a suggestion and a CLAUDE.md line.
function everyKind(): State {
  const s = makeState();
  const now = Date.now();
  const signOff = { ...s.approvals[0]!, id: "apr_signoff", taskId: null, spaceId: null, kind: "create_repo" as State["approvals"][number]["kind"], title: 'Create GitHub repo "demo"?', detail: "A new private repo." };
  return {
    ...s,
    approvals: [...s.approvals, signOff],
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
  expect([...kindsOf(attentionQueue(everyKind()))].sort()).toEqual(["approval", "memory", "paused", "question", "review", "suggestion"]);
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
    // A result's chips say what it is; every other row wears its kind's label.
    const tag = rows[i]!.querySelector(".tag");
    if (rows[i]!.querySelector(".chips")) expect(tag).toBeNull();
    else expect(tag!.textContent).toBe(KIND[item.kind].label);
    const buttons = [...rows[i]!.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe(goTo(item.kind));
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
    expect(primary).toContain(KIND[item.kind].action);
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
    expect(card.keys.find((k) => k.hot)!.label).toBe(KIND[item.kind].action);
  }
});
