import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Palette } from "../../src/dashboard/components/Palette";
import { matchActions, paletteActions } from "../../src/dashboard/palette";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import type { State } from "../../src/engine/state";
import { ids, makeState } from "../tui/fixtures";

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});
openDom();
afterAll(() => closeDom());

// The fixture's review made clean: checks passed and an approving review.
function cleanState(): State {
  const s = makeState();
  return { ...s, tasks: s.tasks.map((t) => (t.id === ids.review ? { ...t, outcome: "done" as const, loop: { ...newLoop(SIZE_BUDGETS.small), stage: "ready" as const, checks: "passed" as const, reviews: [{ reviewer: "codex", verdict: "approve" as const, findings: [], skipped: null }] } } : t)) };
}
const labels = (s: State) => paletteActions(s, { spaceId: null, theme: "system" }).map((a) => a.label);

test("every kind of action is there by name", () => {
  const l = labels(cleanState());
  for (const want of ["New task or space", "New space", "Needs you", "Settings", "Get started", "atrium", "Fix login redirect", "Open Review: Fix login redirect", "Approve Review: Fix login redirect", "Theme: light", "Theme: dark"]) expect(l).toContain(want);
  expect(l.some((x) => x.startsWith("Learning in"))).toBe(true);
});

test("a result that isn't clean opens to be read, never approves by name", () => {
  const l = labels(makeState());
  expect(l).toContain("Open Review: Fix login redirect");
  expect(l).not.toContain("Approve Review: Fix login redirect");
});

test("matching takes every word in any order and ranks word starts first", () => {
  const actions = paletteActions(cleanState(), { spaceId: null, theme: "system" });
  expect(matchActions(actions, "approve login")[0]!.label).toBe("Approve Review: Fix login redirect");
  expect(matchActions(actions, "set")[0]!.label).toBe("Settings");
  expect(matchActions(actions, "zzz")).toEqual([]);
});

test("the palette filters as you type and Enter runs the pick", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  let closed = 0;
  root = createRoot(el);
  act(() => root!.render(<Palette state={cleanState()} spaceId={null} open onClose={() => closed++} onAsk={() => {}} onNewSpace={() => {}} />));
  const input = el.querySelector("input")!;
  const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
  // Read fresh after each render: the handlers close over what the palette shows.
  const props = () => (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void; onKeyDown: (e: { key: string; preventDefault(): void }) => void }>)[key]!;
  act(() => props().onChange({ target: { value: "activity" } }));
  expect(el.querySelector("li.on .palette-label")!.textContent).toBe("Activity");
  await act(async () => props().onKeyDown({ key: "Enter", preventDefault() {} }));
  expect(location.pathname).toBe("/activity");
  expect(closed).toBe(1);
});
