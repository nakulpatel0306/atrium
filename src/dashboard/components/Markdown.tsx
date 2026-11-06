import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeUrl } from "../markdown";

const ALLOWED = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "input", "table", "thead", "tbody", "tr", "th", "td", "a", "hr", "br", "img"];

// Agent text goes straight to React elements: raw HTML is dropped, only web and mail links survive, and images
// show their alt text instead of being fetched (a remote image would tell its server that Nakul looked).
const COMPONENTS: Components = {
  a: ({ href, children }) => (href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>),
  img: ({ alt }) => <span className="md-img">Image: {alt || "untitled"}</span>,
  input: ({ type, checked }) => (type === "checkbox" ? <input type="checkbox" disabled checked={!!checked} readOnly /> : null),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} allowedElements={ALLOWED} unwrapDisallowed components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
