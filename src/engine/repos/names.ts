import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { TEMPLATE_LABELS, type TemplateId } from "./templates";

export class BadDraft extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadDraft";
  }
}

export type ProjectDraft = { name: string; description: string; visibility: "private" | "public"; template: TemplateId };

const NAME_COPY = 'Repo names use letters, numbers, ".", "-" and "_", start with a letter or number, and are at most 100 characters.';
const DESCRIPTION_COPY = "Keep the description to one line under 350 characters.";

export const tildePath = (p: string): string => {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
};

// The name becomes a gh argument, a folder and part of a URL, so only GitHub's own safe subset passes.
export function validateRepoName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.includes("..") || /\.git$/i.test(name)) throw new BadDraft(NAME_COPY);
  return name;
}

export function slugifyName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100)
    .replace(/[-.]+$/, "");
}

export function validateDescription(text: string): string {
  const t = text.trim();
  if (t.length > 350 || /[\u0000-\u001f\u007f]/.test(t)) throw new BadDraft(DESCRIPTION_COPY);
  return t;
}

export function validateGithubSlug(slug: string): { owner: string; name: string } {
  const [owner, name, ...rest] = slug.split("/");
  if (rest.length > 0 || !owner || !name || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) {
    throw new BadDraft(`"${slug}" isn't a GitHub repo. Use owner/name, like nakulpatel0306/atrium.`);
  }
  return { owner, name: validateRepoName(name) };
}

// macOS folders are case-insensitive, so "Atrium" would land in an existing "atrium".
export function projectPath(name: string, root = config().projectsRoot): string {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    // No projects folder yet: nothing can clash.
  }
  const taken = entries.find((e) => e.toLowerCase() === name.toLowerCase());
  if (taken) throw new BadDraft(`A folder named "${taken}" already exists in ${tildePath(root)}. Pick another name.`);
  return join(root, name);
}

export function validateDraft(input: unknown): ProjectDraft {
  if (!input || typeof input !== "object") throw new BadDraft("The draft is missing its fields.");
  const o = input as Record<string, unknown>;
  if (typeof o.name !== "string") throw new BadDraft(NAME_COPY);
  if (typeof o.description !== "string") throw new BadDraft(DESCRIPTION_COPY);
  if (o.visibility !== "private" && o.visibility !== "public") throw new BadDraft("Visibility must be private or public.");
  if (typeof o.template !== "string" || !Object.hasOwn(TEMPLATE_LABELS, o.template)) {
    throw new BadDraft("Template must be bun + TypeScript or Empty.");
  }
  return {
    name: validateRepoName(o.name),
    description: validateDescription(o.description),
    visibility: o.visibility,
    template: o.template as TemplateId,
  };
}

// Whether a checkout's origin points at this GitHub repo, over HTTPS or SSH. GitHub names ignore case.
export function sameGithubRepo(origin: string, slug: string): boolean {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin.trim());
  return !!m && m[1]!.toLowerCase() === slug.toLowerCase();
}
