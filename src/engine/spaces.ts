import type { Database } from "bun:sqlite";
import { bus } from "./events";
import { pickFolder } from "./folders";
import { newId } from "./ids";

export const REVIEWERS = ["codex", "gemini", "claude"] as const;
export type ReviewerId = (typeof REVIEWERS)[number];

export type Space = {
  id: string;
  name: string;
  kind: "repo" | "general" | "markets";
  goal: string;
  color: string;
  repoPath: string | null;
  private: boolean;
  status: "active" | "archived";
  // The agent that reviews finished work here; null means no automatic review.
  reviewBy: ReviewerId | null;
  // The GitHub repo ("owner/name") a repo space comes from; its local copy is cloned when a task needs it.
  github: string | null;
  // Where a general or markets space keeps its files; null for repo spaces, and for old spaces until boot moves them.
  folder: string | null;
  createdAt: number;
  updatedAt: number;
};

type SpaceRow = {
  id: string;
  name: string;
  kind: Space["kind"];
  goal: string;
  color: string;
  repo_path: string | null;
  private: number;
  status: Space["status"];
  review_by: ReviewerId | null;
  github: string | null;
  folder: string | null;
  created_at: number;
  updated_at: number;
};

const DEFAULT_COLOR = "#8ba4b0";

export const MARKETS_PRIVATE = "Markets spaces stay private: your holdings only go to Claude.";

// Holdings and the paper account are Nakul's private data, so a markets space is private whatever its flag says.
export const isPrivate = (space: Pick<Space, "kind" | "private">): boolean => space.private || space.kind === "markets";

const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  goal: r.goal,
  color: r.color,
  repoPath: r.repo_path,
  private: r.private === 1,
  status: r.status,
  reviewBy: r.review_by,
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
  if (input.kind === "markets" && input.private === false) throw new Error(MARKETS_PRIVATE);
  const id = newId("spc");
  const now = Date.now();
  db.query(
    "INSERT INTO spaces (id, name, kind, goal, color, repo_path, private, github, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
  patch: Partial<Pick<Space, "name" | "goal" | "private" | "status" | "reviewBy">>,
): Space {
  const cur = getSpace(db, id);
  if (!cur) throw new Error(`No space with id ${id}`);
  const next = { ...cur, ...patch };
  if (next.kind === "markets" && !next.private) throw new Error(MARKETS_PRIVATE);
  db.query("UPDATE spaces SET name = ?, goal = ?, private = ?, status = ?, review_by = ?, updated_at = ? WHERE id = ?").run(
    next.name,
    next.goal,
    next.private ? 1 : 0,
    next.status,
    next.reviewBy,
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
