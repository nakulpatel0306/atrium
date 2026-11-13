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

test("Enter drafts a brief under the ask; Run sends the edited brief with the answers", async () => {
  const space = repoSpace();
  const el = render(<CommandBar space={space} setupRequest={0} />);
  typeIn(ask(el), "totals on the report");
  await act(async () => void el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(calls[0]).toEqual({ url: "/api/brief", body: { spaceId: space.id, text: "totals on the report" } });
  const card = el.querySelector(".brief-card")!;
  expect(card.textContent).toContain("Which report?");
  expect(card.textContent).toContain(NO_CHECK_HINT);
  await act(async () => button(el, "Monthly").click());
  typeIn(card.querySelector<HTMLTextAreaElement>("label textarea")!, "Totals match the rows\nA zero total shows 0");
  // The hint about acceptance criteria goes once there are some.
  expect(card.textContent).not.toContain("No acceptance criteria");
  await act(async () => button(el, "Run").click());
  const sent = calls.at(-1)!;
  expect(sent.url).toBe("/api/command");
  expect(sent.body).toMatchObject({
    text: "totals on the report",
    spaceId: space.id,
    brief: { goal: "Show totals on the report", acceptance: ["Totals match the rows", "A zero total shows 0"], answers: [{ question: "Which report?", answer: "Monthly" }] },
  });
  expect(el.querySelector(".brief-card")).toBeNull();
});

test("⌘↩ sends the ask straight away, with no brief and no pre-pass", async () => {
  const el = render(<CommandBar space={repoSpace()} setupRequest={0} />);
  typeIn(ask(el), "fix the typo in the footer");
  await key(ask(el), { key: "Enter", metaKey: true });
  expect(calls.map((c) => c.url)).toEqual(["/api/command"]);
  expect((calls[0]!.body as { brief?: unknown }).brief).toBeUndefined();
});

test("Esc discards the brief, and editing the ask drops a stale one", async () => {
  const el = render(<CommandBar space={repoSpace()} setupRequest={0} />);
  typeIn(ask(el), "totals");
  await act(async () => void el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await key(el.querySelector(".brief-card input")!, { key: "Escape" });
  expect(el.querySelector(".brief-card")).toBeNull();
  await act(async () => void el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(el.querySelector(".brief-card")).not.toBeNull();
  typeIn(ask(el), "totals, monthly");
  expect(el.querySelector(".brief-card")).toBeNull();
});

function loopTask(patch: Partial<NonNullable<Task["loop"]>>, status: Task["status"] = "running"): Task {
  const base = makeState().tasks[0]!;
  return { ...base, status, brief: null, loop: { ...newLoop(SIZE_BUDGETS.medium), ...patch } };
}

test("the stage strip shows where the task is, and a pause where it stopped", () => {
  const el = render(<LoopPanel task={loopTask({ stage: "checks", checks: "running" })} showChecks={false} />);
  expect(el.querySelector('.stages [aria-current="step"]')!.textContent).toBe("Checks");
  act(() => root!.render(<LoopPanel task={loopTask({ stage: "writing", paused: { kind: "loop", diagnosis: "x" } }, "blocked")} showChecks={false} />));
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
  const el = render(<LoopPanel task={task} showChecks={false} />);
  expect(el.textContent).toContain("Look closely: This change edits how checks run: package.json.");
  expect(el.textContent).toContain("[high] src/a.ts:3 — misses zero → fixed: guarded it");
  await act(async () => button(el, "Show output").click());
  await act(async () => await Bun.sleep(5));
  expect(el.querySelector(".check-rows pre")!.textContent).toBe("(fail) adds totals");
});
