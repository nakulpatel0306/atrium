// What a task may carry as attached files: shared by the engine and the dashboard, so it imports only pure rules.
import { SECRET } from "./autonomy/kinds";
import { isEnvPath } from "./envpath";

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_NAME = 120;
export const DEFAULT_PROMPT = "Look at the attached files.";
export const ATTACH_DIR = "Attachments";
export const REPO_REFUSED = "Attach files in a regular space for now.";

// The type recorded is the one the name implies, never what the sender claimed.
const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", heic: "image/heic", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const IMAGES = ["png", "jpg", "jpeg", "heic", "gif", "webp"];
export const ALLOWED_EXT = new Set(Object.keys(TYPES));
export const ACCEPT = [...ALLOWED_EXT].map((e) => `.${e}`).join(",");

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
export const isImageName = (name: string) => IMAGES.includes(extOf(name));
export const typeOf = (name: string) => TYPES[extOf(name)] ?? "application/octet-stream";

// Bidi overrides and isolates can make "gpj.exe" read as "exe.jpg"; control characters can hide anything.
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// Only the file's own name survives: no folders, no leading dots (so no hidden files), nothing invisible, and at
// most MAX_NAME characters with the extension kept. Colons become dashes because Finder shows them as slashes.
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let name = base.normalize("NFC").replace(HIDDEN_CHARS, "").replace(/:/g, "-").trim().replace(/^[.\s]+/, "");
  if (!name) name = "file";
  if (name.length > MAX_NAME) {
    const ext = extOf(name);
    const tail = ext && ext.length < 10 ? `.${ext}` : "";
    name = name.slice(0, MAX_NAME - tail.length).trimEnd() + tail;
  }
  return name;
}

const isSecretName = (name: string) => isEnvPath(name) || SECRET.test(name);

// Why a file can't be attached, in words that name it; null when it can. The secrets check runs on the name as
// given (with only invisible characters taken out, so they can't hide ".env") and again on the cleaned name, so
// ".env.png" is refused rather than cleaned into "env.png".
export function refusal(name: string, size: number): string | null {
  const shown = cleanName(name);
  const given = (name.split(/[\\/]/).pop() ?? "").normalize("NFC").replace(HIDDEN_CHARS, "");
  if (isSecretName(given) || isSecretName(shown)) return `${shown} looks like a secrets or key file, so Atrium won't attach it.`;
  if (!ALLOWED_EXT.has(extOf(shown))) return `${shown} isn't a type Atrium can attach. Use images, PDFs, text, Markdown, CSV, JSON, Excel or Word files.`;
  if (size > MAX_FILE_BYTES) return `${shown} is over 25 MB, so Atrium won't attach it.`;
  return null;
}

// Refusal for a whole batch, given what's already attached.
export function batchRefusal(files: { name: string; size: number }[], already: { size: number }[] = []): string | null {
  if (files.length + already.length > MAX_FILES) return `A task can carry at most ${MAX_FILES} files.`;
  for (const f of files) {
    const why = refusal(f.name, f.size);
    if (why) return why;
  }
  const total = [...files, ...already].reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_BYTES) return "Those files add up to more than 100 MB, the most one task can carry.";
  return null;
}

const BLOCK_HEAD = "Attached files (in this space's folder):";
export const attachedBlock = (paths: string[]) => `${BLOCK_HEAD}\n${paths.map((p) => `- ${p}`).join("\n")}`;

// The detail without its trailing file list, for a screen that lists the files itself.
export function withoutBlock(detail: string): string {
  if (detail.startsWith(`${BLOCK_HEAD}\n`)) return "";
  const at = detail.lastIndexOf(`\n\n${BLOCK_HEAD}\n`);
  return at < 0 ? detail : detail.slice(0, at);
}
