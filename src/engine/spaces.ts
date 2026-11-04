import type { Database } from "bun:sqlite";
import { bus } from "./events";
import { newId } from "./ids";

export type Space = {
  id: string;
  name: string;
  kind: "repo" | "general";
  goal: string;
  color: string;
  repoPath: string | null;
  private: boolean;
  status: "active" | "archived";
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
  created_at: number;
  updated_at: number;
};

const DEFAULT_COLOR = "#8ba4b0";

const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  goal: r.goal,
  color: r.color,
  repoPath: r.repo_path,
  private: r.private === 1,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getSpace(db: Database, id: string): Space | null {
  const row = db.query("SELECT * FROM spaces WHERE id = ?").get(id) as SpaceRow | null;
  return row ? toSpace(row) : null;
}

export function createSpace(
  db: Database,
  input: { name: string; kind: Space["kind"]; goal: string; color?: string; repoPath?: string; private?: boolean },
): Space {
  const id = newId("spc");
  const now = Date.now();
  db.query(
    "INSERT INTO spaces (id, name, kind, goal, color, repo_path, private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.name,
    input.kind,
    input.goal,
    input.color ?? DEFAULT_COLOR,
    input.repoPath ?? null,
    (input.private ?? true) ? 1 : 0,
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
  patch: Partial<Pick<Space, "name" | "goal" | "private" | "status">>,
): Space {
  const cur = getSpace(db, id);
  if (!cur) throw new Error(`No space with id ${id}`);
  const next = { ...cur, ...patch };
  db.query("UPDATE spaces SET name = ?, goal = ?, private = ?, status = ?, updated_at = ? WHERE id = ?").run(
    next.name,
    next.goal,
    next.private ? 1 : 0,
    next.status,
    Date.now(),
    id,
  );
  bus.emit({ type: "changed" });
  return getSpace(db, id)!;
}
