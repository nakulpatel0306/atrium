// Pure file-type rules, shared by the engine and the dashboard, so it imports nothing.

export type FileKind = "markdown" | "text" | "image" | "calendar" | "other";

export const TEXT_EXT = new Set("txt csv tsv json yaml yml toml ts tsx js jsx py rb go rs swift sh css html xml log".split(" "));
// SVG can carry script, so it is never shown inline.
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// File types Atrium will open. Anything that can launch code (apps, scripts, .command, HTML) is left out:
// those are only ever revealed in Finder.
export const OPENABLE = new Set(["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "ics", "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "rtf", "docx", "xlsx", "pptx"]);

export const extOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function kindOf(path: string, head?: Uint8Array): FileKind {
  const ext = extOf(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "ics") return "calendar";
  if (ext in IMAGE_TYPES) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return head && looksLikeText(head) ? "text" : "other";
}

export function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    // stream: a multi-byte character cut at the end of the head isn't an error.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}
