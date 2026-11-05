// The draft rules with no file system access, so the dashboard checks a draft with the engine's exact wording.
export const NAME_COPY = 'Repo names use letters, numbers, ".", "-" and "_", start with a letter or number, and are at most 100 characters.';
export const DESCRIPTION_COPY = "Keep the description to one line under 350 characters.";

// The name becomes a gh argument, a folder and part of a URL, so only GitHub's own safe subset passes.
export const nameProblem = (name: string): string | null =>
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.includes("..") || /\.git$/i.test(name) ? NAME_COPY : null;

export const descriptionProblem = (text: string): string | null => {
  const t = text.trim();
  return t.length > 350 || /[\u0000-\u001f\u007f]/.test(t) ? DESCRIPTION_COPY : null;
};

export type TemplateId = "bun-ts" | "empty";

export const TEMPLATE_LABELS: Record<TemplateId, string> = { "bun-ts": "bun + TypeScript", empty: "Empty" };
