import { expect, test } from "bun:test";
import { borderTop, clean, tail, truncate, viewport, width, wrapLines } from "../../src/tui/text";

test("clean strips escapes an agent could use on the terminal", () => {
  expect(clean("a\x1b]52;c;Zm9v\x07b\x1b[2J\x1b]0;title\x07c")).toBe("abc");
  expect(clean("50%\r100%\n")).toBe("100%\n");
  expect(clean("x\ty\x07")).toBe("x  y");
  expect(clean("one\r\ntwo")).toBe("one\ntwo");
  expect(clean("a\x9b2Jb\x7f")).toBe("ab");
});

test("truncate and wrap count display width", () => {
  const cut = truncate("日本語のタイトル", 7);
  expect(width(cut)).toBeLessThanOrEqual(7);
  expect(cut.endsWith("…")).toBe(true);
  expect(wrapLines("日本🙂abc", 4)).toEqual(["日本", "🙂ab", "c"]);
  expect(truncate("short", 10)).toBe("short");
  expect(wrapLines("a\n\nb", 10)).toEqual(["a", "", "b"]);
});

test("viewport keeps the selection visible", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  expect(viewport(items, 0, 10).top).toBe(0);
  expect(viewport(items, 50, 10).top).toBe(45);
  expect(viewport(items, 99, 10).top).toBe(90);
  expect(viewport(items, 99, 10).rows).toHaveLength(10);
  const few = viewport([1, 2, 3], 2, 10);
  expect(few.top).toBe(0);
  expect(few.rows).toEqual([1, 2, 3]);
});

test("tail follows unless scrolled", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
  expect(tail(lines, 10, null)).toEqual(lines.slice(20, 30));
  expect(tail(lines, 10, 5)).toEqual(lines.slice(5, 15));
  expect(tail(lines, 10, 99)).toEqual(lines.slice(20, 30));
});

test("borderTop is exactly as wide as asked", () => {
  const top = borderTop("[1] Spaces", 30);
  expect(width(top)).toBe(30);
  expect(top.startsWith("╭─[1] Spaces─")).toBe(true);
  expect(top.endsWith("╮")).toBe(true);
  expect(width(borderTop("x".repeat(60), 20))).toBe(20);
});
