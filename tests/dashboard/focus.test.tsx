import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DeleteSpace } from "../../src/dashboard/components/DeleteSpace";
import { KeysSheet } from "../../src/dashboard/components/KeysSheet";
import { Palette } from "../../src/dashboard/components/Palette";
import { makeState } from "../tui/fixtures";

let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  globalThis.fetch = realFetch;
});
openDom();
afterAll(() => closeDom());

// The control that opened it, focused first, as a click would leave it.
function opener(): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = "Open";
  document.body.appendChild(b);
  b.focus();
  return b;
}
function mount(node: React.ReactNode): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(node));
  return el;
}
const key = (k: string, shiftKey = false) => act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true })));
const focusables = (el: Element) => [...el.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];

test("the delete dialog keeps Tab inside itself, closes on Escape and gives focus back to what opened it", () => {
  const from = opener();
  let closed = 0;
  const el = mount(<DeleteSpace space={{ id: "spc_1", name: "Lumen API" }} onClose={() => closed++} />);
  const dialog = el.querySelector<HTMLElement>('[role="dialog"]')!;
  const inside = focusables(dialog);
  inside.at(-1)!.focus();
  key("Tab");
  expect(document.activeElement === inside[0]!).toBe(true);
  key("Tab", true);
  expect(document.activeElement === inside.at(-1)!).toBe(true);
  key("Escape");
  expect(closed).toBeGreaterThan(0);
  act(() => root!.unmount());
  root = null;
  expect(document.activeElement === from).toBe(true);
});

test("the palette traps focus and hands it back on closing", () => {
  const from = opener();
  let closed = 0;
  const el = mount(<Palette state={makeState()} spaceId={null} open onClose={() => closed++} onAsk={() => {}} onNewSpace={() => {}} />);
  const input = el.querySelector<HTMLInputElement>(".palette input")!;
  input.focus();
  key("Tab");
  expect(el.querySelector(".palette")!.contains(document.activeElement)).toBe(true);
  key("Escape");
  expect(closed).toBeGreaterThan(0);
  act(() => root!.render(<Palette state={makeState()} spaceId={null} open={false} onClose={() => {}} onAsk={() => {}} onNewSpace={() => {}} />));
  expect(document.activeElement === from).toBe(true);
});

test("the keys sheet keeps Tab inside it and gives focus back when it closes", () => {
  const from = opener();
  const el = mount(<KeysSheet keys={[["j", "Next"]]} kinds onClose={() => {}} />);
  const sheet = el.querySelector<HTMLElement>(".keys-sheet")!;
  const inside = focusables(sheet);
  inside.at(-1)!.focus();
  key("Tab");
  expect(sheet.contains(document.activeElement)).toBe(true);
  act(() => root!.unmount());
  root = null;
  expect(document.activeElement === from).toBe(true);
});

test("Tab in the keys sheet goes round to its What each item asks toggle, not only its Close", () => {
  opener();
  const el = mount(<KeysSheet keys={[["j", "Next"]]} kinds onClose={() => {}} />);
  const summary = el.querySelector<HTMLElement>(".keys-sheet summary")!;
  const close = [...el.querySelectorAll<HTMLButtonElement>(".keys-sheet button")].at(-1)!;
  close.focus();
  key("Tab");
  expect(document.activeElement === summary).toBe(true);
  key("Tab", true);
  expect(document.activeElement === close).toBe(true);
});
