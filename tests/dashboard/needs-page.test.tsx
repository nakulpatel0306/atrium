import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsPage } from "../../src/dashboard/components/NeedsPage";
import { Sidebar } from "../../src/dashboard/components/Sidebar";
import { ACT, isTyping, moveFocus, needsKey } from "../../src/dashboard/needs-keys";
import { parseRoute } from "../../src/dashboard/route";
import type { State } from "../../src/engine/state";
import { ids, makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const key = (k: string, target: unknown = { tagName: "DIV" }, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) => needsKey({ key: k, target: target as EventTarget, ...mods });

test("/needs-you and /activity are routes of their own", () => {
  expect(parseRoute("/needs-you")).toEqual({ name: "needs", item: null, batch: false });
  expect(parseRoute("/needs-you?item=apr_1")).toEqual({ name: "needs", item: "apr_1", batch: false });
  expect(parseRoute("/needs-you?batch=1")).toEqual({ name: "needs", item: null, batch: true });
  expect(parseRoute("/activity")).toEqual({ name: "activity" });
});

test("the sidebar marks Needs you and Activity active on their pages", () => {
  const s = makeState();
  const on = (path: string, label: string) =>
    renderToStaticMarkup(<Sidebar state={s} archived={0} route={parseRoute(path)} onNewSpace={() => {}} />)
      .split("<a ")
      .find((b) => text(b).includes(label))!
      .startsWith('class="nav on"');
  expect(on("/needs-you", "Needs you")).toBe(true);
  expect(on("/activity", "Activity")).toBe(true);
  expect(on("/", "Needs you")).toBe(false);
});

test("j k and the arrows move, Enter opens, a approves, s sends back, x stops, e explains, z takes back, Esc closes", () => {
  expect(["j", "ArrowDown", "k", "ArrowUp", "Enter", "a", "s", "x", "e", "A", "z", "?", "Escape"].map((k) => key(k))).toEqual(["next", "next", "prev", "prev", "open", "approve", "sendBack", "stop", "explain", "batch", "undo", "help", "close"]);
  expect(key("q")).toBeNull();
  expect(key("a", undefined, { metaKey: true })).toBeNull();
  expect(key("k", undefined, { ctrlKey: true })).toBeNull();
});

test("keys are ignored while typing", () => {
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(key("a", { tagName })).toBeNull();
  expect(key("s", { tagName: "DIV", isContentEditable: true })).toBeNull();
  expect(isTyping({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
});

test("focus moves within the list and stops at its ends", () => {
  expect(moveFocus(-1, 3, "next")).toBe(0);
  expect(moveFocus(-1, 3, "prev")).toBe(2);
  expect(moveFocus(0, 3, "next")).toBe(1);
  expect(moveFocus(2, 3, "next")).toBe(2);
  expect(moveFocus(0, 3, "prev")).toBe(0);
  expect(moveFocus(0, 0, "next")).toBe(-1);
});

test("the page lists every waiting row with the keys hint", () => {
  const s = makeState();
  const t = text(renderToStaticMarkup(<NeedsPage state={s} />));
  expect(t).toContain("Needs you · 1");
  expect(t).toContain("Keys ?");
  expect(t).toContain("Review: Fix login redirect");
});

test("on a narrow window the rail opens on tap to show every space's name, and going anywhere closes it", async () => {
  const { openDom, closeDom } = await import("./dom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  openDom();
  const s = makeState();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<Sidebar state={s} archived={0} route={parseRoute("/")} onNewSpace={() => {}} />));
  const toggle = el.querySelector<HTMLButtonElement>(".rail-toggle")!;
  expect(toggle.getAttribute("aria-label")).toBe("Show names");
  // Each space's link carries its name for a tooltip and a screen reader even while folded.
  const link = [...el.querySelectorAll("a")].find((a) => a.getAttribute("title") === "job hunt")!;
  expect(link.textContent).toContain("job hunt");
  act(() => toggle.click());
  expect(el.querySelector("aside")!.className).toBe("open");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  act(() => link.click());
  expect(el.querySelector("aside")!.className).toBe("");
  act(() => root.unmount());
  el.remove();
  closeDom();
});
