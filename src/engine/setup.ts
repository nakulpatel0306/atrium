import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentAdapter } from "./agents/types";
import { config } from "./config";
import { tildePath } from "./folders";
import { ensureProjectsRoot, expandHome } from "./profile";
import type { Approval } from "./approvals";
import { git } from "./git";
import { GhProblem, ghViewRepo } from "./repos/gh";
import { stripHidden } from "./repos/rules";
import { BadDraft, type ProjectDraft, sameGithubRepo, slugifyName, validateDescription, validateGithubSlug, validateRepoName } from "./repos/names";
import { draftProject, type RepoAction } from "./repos/store";
import { createSpace, listSpaces, type Space } from "./spaces";
import { createTask, type Task } from "./tasks";
import { AttachRefused } from "./attachments";
import { capabilityLines } from "./capabilities";

export type SpacePlan = {
  name: string;
  kind: "repo" | "general";
  goal: string;
  repoPath?: string;
  // "owner/name" of an existing GitHub repo to attach; its local copy is cloned when a task needs it.
  github?: string;
  private: boolean;
  tasks: { title: string; detail?: string; weight: "heavy" | "light" }[];
};

export type SetupResult =
  | { space: Space; tasks: Task[] }
  | { draft: RepoAction; approval: Approval };

// Runs inside the transaction that makes a new space and its starter tasks, before anything can start them; returns
// the tasks as they now stand. The ask bar uses it to hand its attached files to the first task.
export type OnCreate = (space: Space, tasks: Task[]) => Task[];

export class BadPlan extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadPlan";
  }
}

export class SetupFailed extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "SetupFailed";
  }
}

const PALETTE = ["#7c7cf5", "#4cb782", "#4ea7fc", "#f2c94c", "#b07cf5", "#eb5757"];
const MAX_TASKS = 8;
const USER_FIXABLE = new Set(["not_installed", "not_logged_in", "rate_limited"]);

const systemBody = (projects: string) => `You set up a new "space" in a personal task dashboard from the user's plain description.
Reply with a single JSON object and nothing else, shaped like:
{"name": string (1-40 chars), "kind": "repo" | "general", "goal": string, "repoPath"?: string, "private": boolean, "tasks": [{"title": string, "detail"?: string, "weight": "heavy" | "light"}]}
Rules:
- Return JSON only: no prose, no code fences.
- Set "private" to true for email, client, and personal work.
- If the description matches an existing project, look under ${projects} for the repo, then use kind "repo" and set repoPath to its absolute path. Otherwise use kind "general" and omit repoPath.
- If the user wants to start or create a new project or repo, reply instead {"kind":"new_project","name": string (a short repo name using letters, numbers, "-", "." or "_"),"description": string (one line),"visibility":"private"|"public","template":"bun-ts"|"empty"}. Use "private" unless the user says public, and "bun-ts" unless the user asks for an empty repo.
- If the user names a GitHub repo ("owner/name") with no folder for it under ${projects}, use kind "repo", set "github" to "owner/name" and omit repoPath.
- Give at most ${MAX_TASKS} starter tasks, with small, concrete titles. Use weight "heavy" for work that edits code or takes a long time and "light" for quick reads and summaries.`;

const systemPrompt = (projectsRoot: string) => [systemBody(tildePath(projectsRoot)), ...capabilityLines()].join("\n");

// Agents wrap JSON in prose or fences, so scan for the first balanced object instead of parsing the whole text.
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const defaultProjectsRoot = () => config().projectsRoot;

// The agent's repoPath is untrusted text that later becomes a cwd for write-capable runs, so it must resolve
// (through symlinks) to a git work tree inside the projects root.
function resolveRepoPath(repoPath: string, projectsRoot: string): string {
  const expanded = expandHome(repoPath);
  if (!isAbsolute(expanded)) throw new BadPlan(`repoPath must be an absolute path: ${repoPath}`);
  let real: string;
  let root: string;
  try {
    real = realpathSync(expanded);
    root = realpathSync(projectsRoot);
  } catch {
    throw new BadPlan(`repoPath does not exist: ${repoPath}`);
  }
  if (!statSync(real).isDirectory()) throw new BadPlan(`repoPath is not a folder: ${repoPath}`);
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new BadPlan(`repoPath must be inside ${projectsRoot}: ${repoPath}`);
  }
  const git = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: real, stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0 || git.stdout.toString().trim() !== "true") {
    throw new BadPlan(`repoPath is not a git repository: ${repoPath}`);
  }
  return real;
}

export function parseSpacePlan(text: string, projectsRoot = defaultProjectsRoot()): SpacePlan {
  const raw = firstJsonObject(text);
  if (!raw) throw new BadPlan("No JSON object in the agent's reply.");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new BadPlan("The agent's JSON could not be parsed.");
  }
  const { name, kind, goal, repoPath, tasks } = obj;
  if (typeof name !== "string" || name.length < 1 || name.length > 40) throw new BadPlan("name must be 1-40 characters.");
  if (kind !== "repo" && kind !== "general") throw new BadPlan('kind must be "repo" or "general".');
  if (typeof goal !== "string") throw new BadPlan("goal must be a string.");
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) throw new BadPlan(`tasks must be a list of at most ${MAX_TASKS}.`);
  const plan: SpacePlan = {
    name,
    kind,
    goal,
    // Private is the safe side: only an explicit false makes a space non-private.
    private: obj.private !== false,
    tasks: tasks.map((t) => {
      if (!t || typeof t.title !== "string" || !t.title) throw new BadPlan("Every task needs a title.");
      if (t.weight !== "heavy" && t.weight !== "light") throw new BadPlan('Task weight must be "heavy" or "light".');
      if (t.detail !== undefined && typeof t.detail !== "string") throw new BadPlan("Task detail must be a string.");
      return t.detail === undefined ? { title: t.title, weight: t.weight } : { title: t.title, detail: t.detail, weight: t.weight };
    }),
  };
  if (obj.github !== undefined) {
    if (typeof obj.github !== "string" || kind !== "repo") throw new BadPlan('github must be "owner/name" on a repo space.');
    try {
      validateGithubSlug(obj.github);
    } catch {
      throw new BadPlan('github must be "owner/name".');
    }
    // The folder for an attached repo is found or cloned by Atrium, never taken from the agent.
    plan.github = obj.github;
  } else if (repoPath !== undefined) {
    if (typeof repoPath !== "string") throw new BadPlan("repoPath must be a string.");
    plan.repoPath = resolveRepoPath(repoPath, projectsRoot);
  }
  return plan;
}

// The agent's reply is untrusted: a new-project reply is reduced to the four draft fields, each normalised to a
// safe value, and can only ever become a draft waiting for Nakul.
export function parseSetupReply(
  text: string,
  projectsRoot = defaultProjectsRoot(),
): SpacePlan | { kind: "new_project"; draft: ProjectDraft } {
  const raw = firstJsonObject(text);
  let obj: Record<string, unknown> | null = null;
  try {
    obj = raw ? JSON.parse(raw) : null;
  } catch {
    // parseSpacePlan reports it.
  }
  if (obj?.kind !== "new_project") return parseSpacePlan(text, projectsRoot);
  let name: string;
  try {
    name = validateRepoName(slugifyName(typeof obj.name === "string" ? obj.name : ""));
  } catch (e) {
    if (e instanceof BadDraft) throw new BadPlan(e.message);
    throw e;
  }
  const firstLine = typeof obj.description === "string" ? (obj.description.split(/[\r\n\u2028\u2029]/)[0] ?? "") : "";
  const description = validateDescription(stripHidden(firstLine.replace(/[\u0000-\u001f\u007f]/g, "")).slice(0, 350));
  return {
    kind: "new_project",
    draft: { name, description, visibility: obj.visibility === "public" ? "public" : "private", template: obj.template === "empty" ? "empty" : "bun-ts" },
  };
}

// A folder under the projects root that's already a checkout of this repo is the user's: it's used, never recorded
// as Atrium's to remove.
async function existingCheckout(slug: string, projectsRoot: string): Promise<string | undefined> {
  const dir = join(projectsRoot, validateGithubSlug(slug).name);
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const origin = await git(dir, ["config", "--get", "remote.origin.url"]);
  if (origin.code !== 0 || !sameGithubRepo(origin.out, slug)) return undefined;
  return resolveRepoPath(dir, projectsRoot);
}

export async function setupSpace(
  db: Database,
  adapter: AgentAdapter,
  description: string,
  cwd?: string,
  projectsRoot = defaultProjectsRoot(),
  onCreate?: OnCreate,
): Promise<SetupResult> {
  try {
    cwd ??= ensureProjectsRoot();
    const result = await adapter.run({
      prompt: description,
      cwd,
      systemPrompt: systemPrompt(projectsRoot),
      allowedTools: ["Read", "Glob"],
      mode: "work",
      onChunk: () => {},
    });
    if (result.status === "error") {
      // These need the user to act (install, log in, wait), so "try again" would mislead.
      if (USER_FIXABLE.has(result.kind)) throw new SetupFailed(result.message);
      throw new Error(result.message);
    }
    const reply = parseSetupReply(result.summary, projectsRoot);
    if (reply.kind === "new_project") {
      const { action, approval } = draftProject(db, reply.draft);
      return { draft: action, approval };
    }
    const plan = reply;
    if (plan.github) {
      let view: Awaited<ReturnType<typeof ghViewRepo>>;
      try {
        view = await ghViewRepo(plan.github);
      } catch (e) {
        if (e instanceof GhProblem) throw new SetupFailed(e.message, e);
        throw e;
      }
      plan.github = view.nameWithOwner;
      plan.private = plan.private || view.isPrivate;
      plan.repoPath = await existingCheckout(plan.github, projectsRoot);
    }
    const color = PALETTE[listSpaces(db, { includeArchived: true }).length % PALETTE.length];
    return db.transaction(() => {
      const space = createSpace(db, {
        name: plan.name,
        kind: plan.kind,
        goal: plan.goal,
        color,
        repoPath: plan.repoPath,
        private: plan.private,
        github: plan.github,
      });
      const tasks = plan.tasks.map((t) => createTask(db, { spaceId: space.id, ...t }));
      return { space, tasks: onCreate ? onCreate(space, tasks) : tasks };
    })();
  } catch (e) {
    // A refused file has its own reason and fix; hiding it behind "try again" would send Nakul round the slow setup for nothing.
    if (e instanceof SetupFailed || e instanceof AttachRefused) throw e;
    throw new SetupFailed("Couldn't set that up. Try describing it again.", e);
  }
}
