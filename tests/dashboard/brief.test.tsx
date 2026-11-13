import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandBar } from "../../src/dashboard/components/CommandBar";
import { LoopPanel } from "../../src/dashboard/components/LoopPanel";
import { NO_CHECK_HINT, normalizeBrief } from "../../src/engine/brief";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import { makeState } from "../tui/fixtures";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

let calls: { url: string; body: unknown }[] = [];
let root: Root | null = null;
const realFetch = globalThis.fetch;

const DRAFT = {
  brief: normalizeBrief({ goal: "Show totals on the report", acceptance: [], size: "small" }),
  questions: [{ question: "Which report?", options: ["Weekly", "Monthly"] }],
  checks: [],
  error: null,
};

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === "/api/brief") return Response.json(DRAFT);
    if (url.endsWith("/checks")) return Response.json([{ id: "chk_1", runId: null, name: "Tests", command: "bun test", status: "failed", exitCode: 1, output: "(fail) adds totals", durationMs: 1200, createdAt: 1 }]);
    return Response.json({ task: { id: "tsk_new", title: body?.text } });
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

const repoSpace = (): Space => makeState().spaces.find((s) => s.kind === "repo")!;

function render(node: React.ReactNode): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(node));
  return el;
}

// happy-dom's inputs don't trip React's change tracking, so typing goes straight to the input's onChange.
function typeIn(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
  const props = (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void }>)[key]!;
  act(() => props.onChange({ target: { value } }));
}
const ask = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[aria-label^="Give"]')!;
const key = async (target: Element, init: KeyboardEventInit) => {
  await act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
};
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

const submit = (el: HTMLElement) => act(async () => void el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

test("Enter runs the task at once; its brief is drafted on the task, with no wait here", async () => {
  const space = repoSpace();
  const el = render(<CommandBar space={space} setupRequest={0} />);
  typeIn(ask(el), "fix the typo in the footer");
  await submit(el);
  expect(calls.map((c) => c.url)).toEqual(["/api/command"]);
  expect((calls[0]!.body as { brief?: unknown }).brief).toBeUndefined();
  expect(el.querySelector(".msg")!.textContent).toContain("Its brief is drafted first, on the task.");
  expect(el.querySelector(".brief-card")).toBeNull();
});

test("⌘↩ drafts the brief here to edit; fields keep spaces and new lines as typed; Run sends it with the answers", async () => {
  const space = repoSpace();
  const el = render(<CommandBar space={space} setupRequest={0} />);
  typeIn(ask(el), "totals on the report");
  await key(ask(el), { key: "Enter", metaKey: true });
  expect(calls[0]).toEqual({ url: "/api/brief", body: { spaceId: space.id, text: "totals on the report" } });
  const card = el.querySelector(".brief-card")!;
  expect(card.textContent).toContain("Which report?");
  expect(card.textContent).toContain(NO_CHECK_HINT);
  expect(card.textContent).toContain("⌘↩ runs · Esc discards");
  await act(async () => button(el, "Monthly").click());
  // One keystroke at a time, as a person types: a trailing space or a new line must survive each step.
  const verify = card.querySelector<HTMLInputElement>("input.mono")!;
  for (const step of ["b", "bun", "bun ", "bun t", "bun test"]) {
    typeIn(verify, step);
    expect(verify.value).toBe(step);
  }
  const acceptance = card.querySelector<HTMLTextAreaElement>("label textarea")!;
  for (const step of ["Totals match", "Totals match\n", "Totals match\nZero ", "Totals match\nZero shows 0"]) {
    typeIn(acceptance, step);
    expect(acceptance.value).toBe(step);
  }
  expect(card.textContent).not.toContain("No acceptance criteria");
  await act(async () => button(el, "Run").click());
  const sent = calls.at(-1)!;
  expect(sent.url).toBe("/api/command");
  expect(sent.body).toMatchObject({
    text: "totals on the report",
    brief: { verify: "bun test", acceptance: ["Totals match", "Zero shows 0"], answers: [{ question: "Which report?", answer: "Monthly" }] },
  });
  expect(el.querySelector(".brief-card")).toBeNull();
});

test("Esc cancels a brief still drafting, and discards one that's shown; editing the ask drops a stale one", async () => {
  let release: () => void = () => {};
  const aborted: boolean[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/brief" && aborted.length === 0) {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted.push(true);
          reject(new DOMException("aborted", "AbortError"));
        });
        release = () => reject(new Error("never"));
      });
    }
    return Response.json(DRAFT);
  }) as typeof fetch;
  const el = render(<CommandBar space={repoSpace()} setupRequest={0} />);
  typeIn(ask(el), "totals");
  // Dispatched without waiting on it: the draft stays in flight until Esc.
  act(() => void ask(el).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));
  await act(async () => await Bun.sleep(5));
  expect(el.querySelector(".msg")!.textContent).toContain("Esc cancels");
  await key(ask(el), { key: "Escape" });
  expect(aborted).toEqual([true]);
  expect(el.querySelector(".msg")).toBeNull();
  expect(el.querySelector(".brief-card")).toBeNull();
  release();
  await key(ask(el), { key: "Enter", metaKey: true });
  await act(async () => await Bun.sleep(5));
  expect(el.querySelector(".brief-card")).not.toBeNull();
  await key(el.querySelector(".brief-card input")!, { key: "Escape" });
  expect(el.querySelector(".brief-card")).toBeNull();
  await key(ask(el), { key: "Enter", metaKey: true });
  await act(async () => await Bun.sleep(5));
  expect(el.querySelector(".brief-card")).not.toBeNull();
  typeIn(ask(el), "totals, monthly");
  expect(el.querySelector(".brief-card")).toBeNull();
});

function loopTask(patch: Partial<NonNullable<Task["loop"]>>, status: Task["status"] = "running"): Task {
  const base = makeState().tasks[0]!;
  return { ...base, status, brief: null, loop: { ...newLoop(SIZE_BUDGETS.medium), ...patch } };
}

test("the stage strip shows where the task is, and a pause where it stopped", () => {
  const el = render(<LoopPanel task={loopTask({ stage: "checks", checks: "running" })} repo showChecks={false} />);
  expect(el.querySelector('.stages [aria-current="step"]')!.textContent).toBe("Checks");
  act(() => root!.render(<LoopPanel task={loopTask({ stage: "writing", paused: { kind: "loop", diagnosis: "x" } }, "blocked")} repo showChecks={false} />));
  expect(el.querySelector('.stages [aria-current="step"]')!.textContent).toBe("Paused");
  expect(button(el, "Give it a hint")).toBeTruthy();
  expect(button(el, "Explain the problem instead")).toBeTruthy();
});

test("failing check output is one click away; findings show how each was answered", async () => {
  const task = loopTask(
    {
      stage: "writing",
      checks: "failed",
      attention: ["This change edits how checks run: package.json."],
      reviews: [{ reviewer: "codex", verdict: "changes", skipped: null, findings: [{ severity: "high", file: "src/a.ts", line: 3, reason: "misses zero", resolution: { action: "fixed", note: "guarded it" } }] }],
    },
    "queued",
  );
  const el = render(<LoopPanel task={task} repo showChecks={false} />);
  expect(el.textContent).toContain("Look closely: This change edits how checks run: package.json.");
  expect(el.textContent).toContain("[high] src/a.ts:3 — misses zero → fixed: guarded it");
  await act(async () => button(el, "Show output").click());
  await act(async () => await Bun.sleep(5));
  expect(el.querySelector(".check-rows pre")!.textContent).toBe("(fail) adds totals");
});

test("a task asking before it starts is in Needs you and its counts, and Start sends the one-tap answers", async () => {
  const { NeedsYou } = await import("../../src/dashboard/components/NeedsYou");
  const { Sidebar } = await import("../../src/dashboard/components/Sidebar");
  const state = makeState();
  const asking = { ...state.tasks[0]!, id: "tsk_asks", title: "Add totals", status: "queued" as const, loop: { ...newLoop(SIZE_BUDGETS.small), stage: "brief" as const, questions: [{ question: "Weekly or monthly?", options: ["Weekly", "Monthly"] }] } };
  const s = { ...state, approvals: [], proposals: [], tasks: [...state.tasks, asking] };
  const el = render(
    <>
      <Sidebar state={s} archived={0} route={{ name: "home" } as never} onNewSpace={() => {}} />
      <NeedsYou state={s} />
    </>,
  );
  expect(el.querySelector(".nav .ct.hot")!.textContent).toBe("1");
  expect(el.textContent).toContain("Needs you · 1");
  expect(el.textContent).toContain("has a question before it starts");
  await act(async () => button(el, "Monthly").click());
  await act(async () => button(el, "Start").click());
  expect(calls.at(-1)).toEqual({ url: "/api/tasks/tsk_asks/answers", body: { answers: [{ question: "Weekly or monthly?", answer: "Monthly" }] } });
});
