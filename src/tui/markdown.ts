// Agent markdown as readable terminal lines: the same tree the dashboard renders, walked into styled text.
import type { ListItem, Nodes, PhrasingContent, Table } from "mdast";
import { markdownTree } from "../dashboard/markdown";
import { type DetailLine, type Styled, wrapStyled } from "./detail";
import { clean, truncate, width } from "./text";
import { color } from "./theme";

type Style = Omit<Styled, "text">;

function inline(nodes: PhrasingContent[], style: Style = {}): Styled[] {
  return nodes.flatMap((n): Styled[] => {
    switch (n.type) {
      case "text":
        return [{ text: n.value, ...style }];
      case "strong":
        return inline(n.children, { ...style, bold: true });
      case "emphasis":
      case "delete":
        return inline(n.children, style);
      case "inlineCode":
        return [{ text: n.value, ...style, color: color.info }];
      case "break":
        return [{ text: "\n", ...style }];
      case "link": {
        const label = inline(n.children, style);
        const said = label.map((s) => s.text).join("");
        return said === n.url ? [{ text: n.url, ...style }] : [...label, { text: ` (${n.url})`, ...style, color: color.muted }];
      }
      case "image":
        return [{ text: `[image: ${n.alt || "untitled"}]`, ...style, color: color.muted }];
      case "html":
        return [{ text: n.value, ...style }];
      default:
        return "children" in n ? inline(n.children as PhrasingContent[], style) : [];
    }
  });
}

// Splits segments at newlines (hard breaks), then wraps each line to fit, with a prefix on the first row and the
// continuation indent on the rest.
function wrapped(segs: Styled[], max: number, first: Styled[] = [], rest: Styled[] = first): DetailLine[] {
  const lines: Styled[][] = [[]];
  for (const s of segs) {
    const parts = s.text.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines.at(-1)!.push({ ...s, text: p });
    });
  }
  const indent = Math.max(width(first.map((s) => s.text).join("")), width(rest.map((s) => s.text).join("")));
  const cols = Math.max(1, max - indent);
  const out: DetailLine[] = [];
  for (const line of lines) {
    for (const row of wrapStyled(line, cols)) out.push([...(out.length === 0 ? first : rest), ...row]);
  }
  return out;
}

function table(t: Table, max: number): DetailLine[] {
  const cells = t.children.map((row) => row.children.map((c) => truncate(inline(c.children).map((s) => s.text).join("").replace(/\n/g, " "), max)));
  const n = Math.max(...cells.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...cells.map((r) => width(r[i] ?? ""))));
  const room = Math.max(n, max - 3 * (n - 1));
  // Narrow the widest column until the row fits the pane.
  while (widths.reduce((a, b) => a + b, 0) > room) {
    const wide = widths.indexOf(Math.max(...widths));
    if (widths[wide]! <= 1) break;
    widths[wide]!--;
  }
  const pad = (s: string, w: number) => {
    const cut = truncate(s, w);
    return cut + " ".repeat(Math.max(0, w - width(cut)));
  };
  const rows: DetailLine[] = cells.map((r, ri) => [{ text: widths.map((w, i) => pad(r[i] ?? "", w)).join(" │ ").trimEnd(), ...(ri === 0 ? { bold: true } : {}) }]);
  const rule: DetailLine = [{ text: "─".repeat(Math.min(max, widths.reduce((a, b) => a + b, 0) + 3 * (n - 1))), color: color.muted }];
  return [rows[0]!, rule, ...rows.slice(1)];
}

function item(li: ListItem, marker: string, max: number): DetailLine[] {
  const box = li.checked === true ? "[x] " : li.checked === false ? "[ ] " : marker;
  const body = li.children.flatMap((c) => block(c, max - 2));
  if (body.length === 0) return [[{ text: box.trimEnd() }]];
  // The marker sits on the first row; everything after it is indented two columns.
  const [head, ...tail] = body;
  const first = wrapped(head!, max, [{ text: box }], [{ text: "  " }]);
  return [...first, ...tail.map((l) => (l.length ? [{ text: "  " }, ...l] : l))];
}

function block(node: Nodes, max: number): DetailLine[] {
  switch (node.type) {
    case "paragraph":
      return wrapped(inline(node.children), max);
    case "heading":
      return wrapped(inline(node.children, { bold: true, color: color.accent }), max);
    case "list":
      return node.children.flatMap((li, i) => item(li, node.ordered ? `${(node.start ?? 1) + i}. ` : "• ", max));
    case "code":
      return node.value.split("\n").map((l) => [{ text: `  ${truncate(l, max - 2)}`, color: color.muted }]);
    case "blockquote":
      return node.children.flatMap((c) => block(c, max - 2)).map((l) => [{ text: "│ ", color: color.muted }, ...l.map((s) => ({ ...s, color: s.color ?? color.muted }))]);
    case "thematicBreak":
      return [[{ text: "─".repeat(Math.min(40, max)), color: color.muted }]];
    case "table":
      return table(node, max);
    case "html":
      return wrapped([{ text: node.value }], max);
    default:
      return [];
  }
}

export function markdownLines(text: string, maxWidth = 100): DetailLine[] {
  const root = markdownTree(clean(text));
  const out: DetailLine[] = [];
  for (const node of root.children) {
    const lines = block(node, maxWidth);
    if (!lines.length) continue;
    if (out.length) out.push([]);
    out.push(...lines);
  }
  return out;
}
