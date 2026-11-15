import { closeDom, openDom } from "./dom";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangesList, ChangesView, splitRows } from "../../src/dashboard/components/ChangesView";
import type { DiffFile, DiffHunk, DiffResult } from "../../src/engine/diff-parse";
import { ids, makeState } from "../tui/fixtures";

let root: Root | null = null;
let asked: string[] = [];
const realFetch = globalThis.fetch;
const HUNK: DiffHunk = {
  header: "@@ -1,4 +1,4 @@",
  lines: [
    { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
    { kind: "del", text: "b", oldNo: 2 },
    { kind: "del", text: "c", oldNo: 3 },
    { kind: "add", text: "B", newNo: 2 },
    { kind: "ctx", text: "d", oldNo: 4, newNo: 3 },
    { kind: "add", text: "e", newNo: 4 },
  ],
};
const file = (path: string, hunks: DiffHunk[]): DiffFile => ({ path, status: "modified", additions: 2, deletions: 2, binary: false, truncated: false, hunks });
const diff = (files: DiffFile[], turns?: DiffResult["turns"]): DiffResult => ({ files, totals: { files: files.length, additions: 2, deletions: 2 }, truncated: false, ...(turns ? { turns } : {}) });

beforeEach(() => {
  asked = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    const turns = [{ sha: "a1", title: "Add the helper", at: 1 }, { sha: "b2", title: "Cover it", at: 2 }];
    return Response.json(url.includes("?turn=a1") ? diff([file("one.ts", [HUNK])], turns) : diff([file("one.ts", [HUNK]), file("two.ts", [HUNK])], turns));
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

test("split view pairs each run of removed lines with the added lines after it", () => {
  expect(splitRows(HUNK).map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
    ["a", "a"],
    ["b", "B"],
    ["c", null],
    ["d", "d"],
    [null, "e"],
  ]);
  const html = renderToStaticMarkup(<ChangesList diff={diff([file("one.ts", [HUNK])])} live={null} mode="split" />);
  expect(html).toContain('class="chg-lines mono split"');
  expect(html).toContain('colSpan="4"');
  // The number gutters are sized by the table's own columns, so the code gets the width.
  expect(html).toContain('<colgroup><col class="chg-no-col"/><col/><col class="chg-no-col"/><col/></colgroup>');
});

test("the Changes view offers each turn on its own and remembers the layout", async () => {
  const task = makeState().tasks.find((t) => t.id === ids.review)!;
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(<ChangesView task={{ ...task, status: "review" }} agent="Claude" />));
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  const select = el.querySelector<HTMLSelectElement>('select[aria-label="Which changes"]')!;
  expect([...select.options].map((o) => o.textContent)).toEqual(["All changes", "Turn 1: Add the helper", "Turn 2: Cover it"]);
  await act(async () => {
    select.value = "a1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  expect(asked.at(-1)).toBe(`/api/tasks/${ids.review}/diff?turn=a1`);
  expect(el.querySelectorAll(".chg-file").length).toBe(1);
  const split = [...el.querySelectorAll<HTMLButtonElement>(".seg button")].find((b) => b.textContent === "Split")!;
  await act(async () => split.click());
  expect(split.getAttribute("aria-pressed")).toBe("true");
  expect(localStorage.getItem("atrium.diffMode")).toBe("split");
  expect(el.querySelector(".chg-lines.split")).not.toBeNull();
});

test("a large diff renders within a budget, with long files folded", () => {
  // About the view's 200 KB cap: 40 files of 120 lines plus one long generated file.
  const lines = (n: number): DiffHunk => ({ header: `@@ -1,${n} +1,${n} @@`, lines: Array.from({ length: n }, (_, i) => ({ kind: i % 3 ? "add" : "ctx", text: `const value${i} = compute(${i}); // a line of ordinary width`, newNo: i + 1, ...(i % 3 ? {} : { oldNo: i + 1 }) }) as DiffHunk["lines"][number]) });
  const files = [...Array.from({ length: 40 }, (_, i) => file(`src/f${i}.ts`, [lines(120)])), file("dist/bundle.js", [lines(2000)])];
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  const started = performance.now();
  act(() => root!.render(<ChangesList diff={diff(files)} live={null} />));
  const ms = performance.now() - started;
  // The 2,000-line file starts folded, so it costs nothing until opened.
  expect(el.querySelectorAll("tr.chg-add, tr.chg-ctx").length).toBe(40 * 120);
  expect(ms).toBeLessThan(1500);
});
