import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "./agents/types";
import { createSpace, listSpaces, type Space } from "./spaces";
import { createTask, type Task } from "./tasks";

export type SpacePlan = {
  name: string;
  kind: "repo" | "general";
  goal: string;
  repoPath?: string;
  private: boolean;
  tasks: { title: string; detail?: string; weight: "heavy" | "light" }[];
};

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

const SYSTEM_PROMPT = `You set up a new "space" in a personal task dashboard from the user's plain description.
Reply with a single JSON object and nothing else, shaped like:
{"name": string (1-40 chars), "kind": "repo" | "general", "goal": string, "repoPath"?: string, "private": boolean, "tasks": [{"title": string, "detail"?: string, "weight": "heavy" | "light"}]}
Rules:
- Return JSON only: no prose, no code fences.
- Set "private" to true for email, client, and personal work.
- If the description matches an existing project, look under ~/dev-workspace/projects for the repo, then use kind "repo" and set repoPath to its absolute path. Otherwise use kind "general" and omit repoPath.
- Give at most ${MAX_TASKS} starter tasks, with small, concrete titles. Use weight "heavy" for work that edits code or takes a long time and "light" for quick reads and summaries.`;

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

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

export function parseSpacePlan(text: string): SpacePlan {
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
    private: obj.private === true,
    tasks: tasks.map((t) => {
      if (!t || typeof t.title !== "string" || !t.title) throw new BadPlan("Every task needs a title.");
      if (t.weight !== "heavy" && t.weight !== "light") throw new BadPlan('Task weight must be "heavy" or "light".');
      if (t.detail !== undefined && typeof t.detail !== "string") throw new BadPlan("Task detail must be a string.");
      return t.detail === undefined ? { title: t.title, weight: t.weight } : { title: t.title, detail: t.detail, weight: t.weight };
    }),
  };
  if (repoPath !== undefined) {
    if (typeof repoPath !== "string") throw new BadPlan("repoPath must be a string.");
    const abs = expandHome(repoPath);
    if (!existsSync(abs)) throw new BadPlan(`repoPath does not exist: ${repoPath}`);
    plan.repoPath = abs;
  }
  return plan;
}

export async function setupSpace(
  db: Database,
  adapter: AgentAdapter,
  description: string,
  cwd = join(homedir(), "dev-workspace"),
): Promise<{ space: Space; tasks: Task[] }> {
  try {
    const result = await adapter.run({
      prompt: description,
      cwd,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: ["Read", "Glob"],
      onChunk: () => {},
    });
    if (result.status === "error") throw new Error(result.message);
    const plan = parseSpacePlan(result.summary);
    const color = PALETTE[listSpaces(db, { includeArchived: true }).length % PALETTE.length];
    return db.transaction(() => {
      const space = createSpace(db, {
        name: plan.name,
        kind: plan.kind,
        goal: plan.goal,
        color,
        repoPath: plan.repoPath,
        private: plan.private,
      });
      const tasks = plan.tasks.map((t) => createTask(db, { spaceId: space.id, ...t }));
      return { space, tasks };
    })();
  } catch (e) {
    throw new SetupFailed("Couldn't set that up. Try describing it again.", e);
  }
}
