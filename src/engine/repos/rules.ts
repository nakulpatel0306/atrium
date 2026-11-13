// The draft rules with no file system access, so the dashboard checks a draft with the engine's exact wording.
export const NAME_COPY = 'Repo names use letters, numbers, ".", "-" and "_", start with a letter or number, and are at most 100 characters.';
export const DESCRIPTION_COPY = "Keep the description to one line under 350 characters.";

// The name becomes a gh argument, a folder and part of a URL, so only GitHub's own safe subset passes.
// A trailing "." is dropped by GitHub, so the repo would get a different name from its folder.
export const nameProblem = (name: string): string | null =>
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.includes("..") || /\.git$/i.test(name) || name.endsWith(".") ? NAME_COPY : null;

// Invisible characters that can make text read differently from what it holds, or carry data nobody sees: C1
// controls, the soft hyphen, the combining grapheme joiner, Hangul and Mongolian fillers and separators, the Arabic
// letter mark, Khmer inherent vowels, zero-width and direction marks, bidi embeddings, overrides and isolates, word
// joiners, line and paragraph separators, variation selectors (both blocks), the BOM, interlinear annotation marks
// and tag characters. Used for repo descriptions, including the one setup writes for a new project.
const HIDDEN_TEXT =
  /[\u0080-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\u2028\u2029\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

const hasHidden = (s: string): boolean => new RegExp(HIDDEN_TEXT.source, "u").test(s);
export const stripHidden = (s: string): string => s.replace(new RegExp(HIDDEN_TEXT.source, "gu"), "");

export const descriptionProblem = (text: string): string | null => {
  const t = text.trim();
  return t.length > 350 || /[\u0000-\u001f\u007f]/.test(t) || hasHidden(t) ? DESCRIPTION_COPY : null;
};

export type TemplateId = "bun-ts" | "empty";

export const TEMPLATE_LABELS: Record<TemplateId, string> = { "bun-ts": "bun + TypeScript", empty: "Empty" };
