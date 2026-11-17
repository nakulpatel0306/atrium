import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NeedsPage } from "../../src/dashboard/components/NeedsPage";
import { SpaceView } from "../../src/dashboard/components/SpaceView";
import { newLoop, SIZE_BUDGETS, type LoopState } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import { ids, makeState } from "../tui/fixtures";

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
});
