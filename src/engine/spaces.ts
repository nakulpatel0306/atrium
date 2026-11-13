import type { Database } from "bun:sqlite";
import { bus } from "./events";
import { pickFolder } from "./folders";
import { newId } from "./ids";
import type { Budget } from "./loop";

export const REVIEWERS = ["codex", "gemini", "claude"] as const;
export type ReviewerId = (typeof REVIEWERS)[number];
// Auto picks a reviewer from another vendor when one can work here, else a fresh Claude session.
export const REVIEW_CHOICES = ["auto", ...REVIEWERS, "off"] as const;
export type ReviewChoice = (typeof REVIEW_CHOICES)[number];

export type Space = {
  id: string;
  name: string;
  kind: "repo" | "general";
  goal: string;
  color: string;
  repoPath: string | null;
  private: boolean;
  // True for a space whose kind no longer exists (see toSpace); it is treated as a plain general space.
  unknownKind: boolean;
  status: "active" | "archived";
  // Who reviews finished code here before the user sees it.
  reviewBy: ReviewChoice;
  // The space's own check commands, one per line, in place of the ones Atrium detects; null to detect.
  checks: string | null;
  // The space's budget for each task, in place of the defaults by task size; null for those defaults.
  budget: Budget | null;
  // The GitHub repo ("owner/name") a repo space comes from; its local copy is cloned when a task needs it.
  github: string | null;
  // Where a general space keeps its files; null for repo spaces, and for old spaces until boot moves them.
  folder: string | null;
  createdAt: number;
  updatedAt: number;
};

type SpaceRow = {
  id: string;
  name: string;
  // Whatever the row holds, including kinds of spaces Atrium no longer has (see toSpace).
  kind: string;
  goal: string;
  color: string;
  repo_path: string | null;
  private: number;
  status: Space["status"];
  review_by: string | null;
  checks?: string | null;
  budget?: string | null;
  github: string | null;
  folder: string | null;
  created_at: number;
  updated_at: number;
};

const DEFAULT_COLOR = "#8ba4b0";

const KNOWN_KINDS = new Set(["repo", "general"]);

// A database from an older Atrium can hold spaces of kinds that no longer exist (Investing, Inbox). They show as plain
// general spaces, and as private ones: those held personal data, and a private space only ever goes to Claude.
const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  name: r.name,
  kind: r.kind === "repo" ? "repo" : "general",
  goal: r.goal,
  color: r.color,
  repoPath: r.repo_path,
  private: r.private === 1 || !KNOWN_KINDS.has(r.kind),
  unknownKind: !KNOWN_KINDS.has(r.kind),
  status: r.status,
  // Spaces from before the loop stored no reviewer as NULL; every coding task is reviewed now unless turned off.
  reviewBy: REVIEW_CHOICES.includes(r.review_by as ReviewChoice) ? (r.review_by as ReviewChoice) : "auto",
  checks: r.checks ?? null,
  budget: r.budget ? (JSON.parse(r.budget) as Budget) : null,
  github: r.github,
  folder: r.folder,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getSpace(db: Database, id: string): Space | null {
  const row = db.query("SELECT * FROM spaces WHERE id = ?").get(id) as SpaceRow | null;
  return row ? toSpace(row) : null;
}

export function createSpace(
  db: Database,
  input: { name: string; kind: Space["kind"]; goal: string; color?: string; repoPath?: string; private?: boolean; github?: string },
): Space {
  const id = newId("spc");
  const now = Date.now();
  db.query(
    "INSERT INTO spaces (id, name, kind, goal, color, repo_path, private, github, folder, folder_ino, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.name,
    input.kind,
    input.goal,
    input.color ?? DEFAULT_COLOR,
    input.repoPath ?? null,
    (input.private ?? true) ? 1 : 0,
    input.github ?? null,
    input.kind === "repo" ? null : pickFolder(db, input.name),
    // Not made yet: a run makes the folder and records its identity (see ensureSpaceFolder).
    input.kind === "repo" ? null : 0,
    now,
    now,
  );
  bus.emit({ type: "changed" });
  return getSpace(db, id)!;
}

export function listSpaces(db: Database, opts: { includeArchived?: boolean } = {}): Space[] {
  const where = opts.includeArchived ? "" : "WHERE status = 'active'";
  const rows = db.query(`SELECT * FROM spaces ${where} ORDER BY created_at, rowid`).all() as SpaceRow[];
  return rows.map(toSpace);
}

export function updateSpace(
  db: Database,
  id: string,
  patch: Partial<Pick<Space, "name" | "goal" | "private" | "status" | "reviewBy" | "checks" | "budget">>,
): Space {
  const cur = getSpace(db, id);
  if (!cur) throw new Error(`No space with id ${id}`);
  const next = { ...cur, ...patch };
  db.query("UPDATE spaces SET name = ?, goal = ?, private = ?, status = ?, review_by = ?, checks = ?, budget = ?, updated_at = ? WHERE id = ?").run(
    next.name,
    next.goal,
    next.private ? 1 : 0,
    next.status,
    next.reviewBy,
    next.checks?.trim() || null,
    next.budget ? JSON.stringify(next.budget) : null,
    Date.now(),
    id,
  );
  bus.emit({ type: "changed" });
  return getSpace(db, id)!;
}

// Where the space's local copy lives. Clearing repoPath keeps github unless the patch says otherwise.
export function setSpaceRepo(db: Database, id: string, patch: { repoPath: string | null; github?: string | null }): Space {
  const cur = getSpace(db, id);
  if (!cur) throw new Error(`No space with id ${id}`);
  const github = patch.github === undefined ? cur.github : patch.github;
  db.query("UPDATE spaces SET repo_path = ?, github = ?, updated_at = ? WHERE id = ?").run(patch.repoPath, github, Date.now(), id);
  bus.emit({ type: "changed" });
  return getSpace(db, id)!;
}
