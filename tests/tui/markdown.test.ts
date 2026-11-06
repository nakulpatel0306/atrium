import { expect, test } from "bun:test";
import { markdownLines } from "../../src/tui/markdown";
import { width } from "../../src/tui/text";

const text = (lines: ReturnType<typeof markdownLines>) => lines.map((l) => l.map((s) => s.text).join(""));

test("bold becomes a bold segment, with no markers left", () => {
  const lines = markdownLines("Buy **Milk** today.");
  expect(lines[0]!.find((s) => s.text === "Milk")?.bold).toBe(true);
  expect(text(lines).join("\n")).not.toContain("*");
});

test("tables line up by display width", () => {
  const out = text(markdownLines("| Item | Qty |\n| --- | --- |\n| Bananas | 6 |\n| Café ☕ | 12 |"));
  const bars = out.filter((l) => l.includes("│")).map((l) => width(l.slice(0, l.indexOf("│"))));
  expect(new Set(bars).size).toBe(1);
  expect(out.some((l) => /^─+/.test(l))).toBe(true);
  expect(out[0]).toContain("Item");
});

test("nothing is wider than the pane", () => {
  const md = "# A long heading that goes on\n\n| Column one | Column two is long |\n| --- | --- |\n| some text here | more text over there |\n\n---";
  for (const l of text(markdownLines(md, 20))) expect(width(l)).toBeLessThanOrEqual(20);
});

test("lists, checklists, links, code and quotes read plainly", () => {
  const out = text(markdownLines("- [x] eggs\n- [ ] bread\n\n1. first\n2. second\n\n[the docs](https://x.com) and https://y.com\n\n```\nconst a = 1;\n```\n\n> quoted\n\n![chart](c.png)"));
  expect(out).toContain("[x] eggs");
  expect(out).toContain("[ ] bread");
  expect(out).toContain("1. first");
  expect(out.join("\n")).toContain("the docs (https://x.com) and https://y.com");
  expect(out).toContain("  const a = 1;");
  expect(out).toContain("│ quoted");
  expect(out.join("\n")).toContain("[image: chart]");
});

test("raw HTML is shown as text and escapes are stripped", () => {
  const out = text(markdownLines("<script>x</script>\n\nhi \x1b[31mred\x1b[0m")).join("\n");
  expect(out).toContain("<script>x</script>");
  expect(out).not.toContain("\x1b");
});
