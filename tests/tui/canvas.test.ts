import { expect, test } from "bun:test";
import { box, columns, edgeWith, fit, keyRow, lineWidth, plainText, rule, slice, splice } from "../../src/tui/canvas";

test("fit makes a line exactly as wide as asked, cutting with an ellipsis", () => {
  expect(lineWidth(fit([{ text: "abc" }], 6))).toBe(6);
  expect(plainText(fit([{ text: "abcdef" }, { text: "gh" }], 4))).toBe("abc…");
  expect(lineWidth(fit([{ text: "日本語のテキスト" }], 7))).toBe(7);
  // Control bytes never reach a row.
  expect(plainText(fit([{ text: "a\x1b[2Jb" }], 4))).toBe("ab  ");
});

test("boxes, edges, rules and columns line up to the column", () => {
  const b = box([{ text: "Title" }], [[{ text: "body" }]], 20, 4);
  expect(b).toHaveLength(4);
  for (const l of b) expect(lineWidth(l)).toBe(20);
  expect(plainText(b[0]!)).toBe("╭─ Title ──────────╮");
  expect(plainText(b[3]!)).toBe("╰──────────────────╯");
  expect(lineWidth(edgeWith([{ text: "✓ Done." }], 30))).toBe(30);
  expect(lineWidth(rule([{ text: "LIVE" }], 30))).toBe(30);
  const cols = columns([{ lines: [[{ text: "left" }]], w: 10 }, { lines: [[{ text: "right" }]], w: 8 }], 2, 1);
  for (const l of cols) expect(lineWidth(l)).toBe(19);
});

test("splice draws over the covered cells and keeps the rest; a wide character cut in half becomes a space", () => {
  const base = [[{ text: "0123456789" }]];
  expect(plainText(splice(base, [[{ text: "ab" }]], 3, 0)[0]!)).toBe("012ab56789");
  expect(plainText(slice([{ text: "a日b" }], 0, 2))).toBe("a ");
  expect(plainText(slice([{ text: "a日b" }], 2, 4))).toBe(" b");
});

test("a row of key caps knows where each key is, for clicks", () => {
  const { line, hits } = keyRow([{ key: "s", label: "Send", input: "s", hot: true }, { key: "x", label: "Skip", input: "x" }], 2, 7);
  expect(plainText(line)).toBe(" s  Send   x  Skip");
  expect(hits).toEqual([
    { x: 2, y: 7, w: 8, h: 1, click: { input: "s" } },
    { x: 12, y: 7, w: 8, h: 1, click: { input: "x" } },
  ]);
});
