import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../src/dashboard/components/Markdown";
import { ThreadList } from "../../src/dashboard/components/Thread";
import { summaryLine } from "../../src/dashboard/summary";
import { plainText, safeUrl } from "../../src/dashboard/markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test("renders bold, lists, GFM tables and checklists", () => {
  const out = html("**Milk**\n\n- [x] eggs\n- [ ] bread\n\n| Item | Qty |\n| --- | --- |\n| Bananas | 6 |\n");
  expect(out).toContain("<strong>Milk</strong>");
  expect(out.match(/<input type="checkbox" disabled/g)?.length).toBe(2);
  expect(out.match(/checked/g)?.length).toBe(1);
  expect(out).toContain("<table>");
  expect(out).toContain('class="md-table"');
  expect(out.startsWith('<div class="md">')).toBe(true);
});

test("drops raw HTML and scripts", () => {
  const out = html('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\nsay <b>hi</b>\n\n<a href="file:///etc/passwd">x</a>');
  expect(out).not.toContain("<script");
  expect(out).not.toContain("onerror");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<b>");
  expect(out).not.toContain("file:");
});

test("filters URLs", () => {
  const out = html("[a](javascript:alert(1)) [b](file:///etc/passwd) [c](grocery-list.md) [d](https://example.com) [e](mailto:me@example.com)");
  expect(out).not.toContain("javascript:");
  expect(out).not.toContain("file:");
  expect(out).not.toContain('href="grocery-list.md"');
  expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">d</a>');
  expect(out).toContain('href="mailto:me@example.com"');
  expect(out).toContain("<span>a</span>");
  expect(safeUrl("HTTPS://x.com")).toBe("HTTPS://x.com");
  expect(safeUrl("//evil.com")).toBe("");
  expect(safeUrl(" javascript:x")).toBe("");
});

test("never fetches images", () => {
  const out = html("![receipt](https://tracker.example/p.png) and ![](https://t.example/q.png)");
  expect(out).toContain("Image: receipt");
  expect(out).toContain("Image: untitled");
  expect(out).not.toContain("<img");
  expect(out).not.toContain("tracker.example");
});

test("plainText flattens markdown to one line", () => {
  expect(plainText("**Done.** See the *list*:\n\n- a\n- b")).toBe("Done. See the list: a; b");
  expect(plainText("| Item | Qty |\n| --- | --- |\n| Bananas | 6 |")).toBe("Item Qty Bananas 6");
  expect(plainText("# Title")).toBe("Title");
  expect(plainText("[the list](https://x.com) and ![alt text](x.png) and `code`")).toBe("the list and alt text and code");
});

test("thread messages render as markdown", () => {
  const out = renderToStaticMarkup(
    <ThreadList messages={[{ id: "m1", spaceId: "s", taskId: "t", fromAgent: "codex", toAgent: "claude", body: "**Approve.** Looks `good`.", createdAt: 1 }]} />,
  );
  expect(out).not.toContain("**");
  expect(out).toContain("<strong>Approve.</strong>");
});
test("summaryLine is the first paragraph as plain text", () => {
  expect(summaryLine("**Done.** Made the list.\n\n- a\n- b")).toBe("Done. Made the list.");
  expect(summaryLine("")).toBe("");
});
