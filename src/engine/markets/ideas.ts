import type { Database } from "bun:sqlite";
import { bus } from "../events";
import { listHoldings } from "./holdings";
import { listWatchlist } from "./watchlist";

export type Stage = "watching" | "researching" | "owned" | "sold";
export type Idea = { key: string; stage: Stage; note: string; stageAt: number; stored: boolean };
export const STAGES: Stage[] = ["watching", "researching", "owned", "sold"];

type Row = { key: string; stage: Stage; note: string; stage_at: number };

// Stored ideas, plus every watchlist symbol without one as an implicit "watching".
export function listIdeas(db: Database, spaceId: string): Idea[] {
  const rows = db.query("SELECT key, stage, note, stage_at FROM market_ideas WHERE space_id = ?").all(spaceId) as Row[];
  const ideas: Idea[] = rows.map((r) => ({ key: r.key, stage: r.stage, note: r.note, stageAt: r.stage_at, stored: true }));
  const have = new Set(ideas.map((i) => i.key));
  for (const w of listWatchlist(db, spaceId)) if (!have.has(w.key)) ideas.push({ key: w.key, stage: "watching", note: "", stageAt: w.addedAt, stored: false });
  return ideas.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || b.stageAt - a.stageAt);
}

export function setIdea(db: Database, spaceId: string, key: string, patch: { stage?: Stage; note?: string }): Idea {
  if (patch.stage !== undefined && !STAGES.includes(patch.stage)) throw new Error("Pick watching, researching, owned or sold.");
  if (patch.note !== undefined && (typeof patch.note !== "string" || patch.note.length > 5000)) throw new Error("Keep the note under 5,000 characters.");
  const now = Date.now();
  const cur = db.query("SELECT stage, note FROM market_ideas WHERE space_id = ? AND key = ?").get(spaceId, key) as { stage: Stage; note: string } | null;
  const stage = patch.stage ?? cur?.stage ?? "watching";
  db.query(
    `INSERT INTO market_ideas (space_id, key, stage, note, stage_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(space_id, key) DO UPDATE SET stage = excluded.stage, note = excluded.note,
       stage_at = CASE WHEN market_ideas.stage = excluded.stage THEN market_ideas.stage_at ELSE excluded.stage_at END`,
  ).run(spaceId, key, stage, patch.note ?? cur?.note ?? "", now, now);
  bus.emit({ type: "changed" });
  return listIdeas(db, spaceId).find((i) => i.key === key)!;
}

// Holdings say what's owned: held keys become "owned", and owned ideas no longer held become "sold".
export function syncIdeas(db: Database, spaceId: string): void {
  const held = new Set(listHoldings(db, spaceId).map((h) => h.key));
  const now = Date.now();
  const stored = db.query("SELECT key, stage FROM market_ideas WHERE space_id = ?").all(spaceId) as { key: string; stage: Stage }[];
  const put = db.query(
    `INSERT INTO market_ideas (space_id, key, stage, note, stage_at, created_at) VALUES (?, ?, ?, '', ?, ?)
     ON CONFLICT(space_id, key) DO UPDATE SET stage = excluded.stage, stage_at = excluded.stage_at`,
  );
  db.transaction(() => {
    for (const key of held) if (stored.find((s) => s.key === key)?.stage !== "owned") put.run(spaceId, key, "owned", now, now);
    for (const s of stored) if (s.stage === "owned" && !held.has(s.key)) put.run(spaceId, s.key, "sold", now, now);
  })();
}
