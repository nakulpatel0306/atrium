import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Agent text is markdown. The dashboard renders it with react-markdown; the terminal app and every one-line
// context (row summaries, titles, tooltips) walk the same tree.

const parser = unified().use(remarkParse).use(remarkGfm);

export function markdownTree(text: string): Root {
  return parser.parse(text);
}

// Only links that leave for the web or mail survive; relative paths, file: and javascript: become plain text.
export function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? url : "";
}

export function plainText(text: string): string {
  return flat(markdownTree(text)).replace(/\s+/g, " ").trim();
}

function flat(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "image":
      return node.alt ?? "";
    case "break":
      return " ";
    case "html":
      return "";
    case "list":
      return node.children.map(flat).map((s) => s.trim()).filter(Boolean).join("; ");
    case "root":
    case "listItem":
    case "blockquote":
    case "table":
    case "tableRow":
      return node.children.map(flat).join(" ");
    default:
      return "children" in node ? (node.children as Nodes[]).map(flat).join("") : "";
  }
}
