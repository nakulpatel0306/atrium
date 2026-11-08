import type { Database } from "bun:sqlite";
import { createSpace, listSpaces } from "../spaces";

const SPACE_NAME = "Investing";
const GOAL = "Track holdings, watchlists and research.";

// Idempotent, and never adds tickers: holdings come from the user's own import or from what they add. An existing
// Investing space is reused as it is.
export function setupInvesting(db: Database): { spaceId: string; created: boolean } {
  const existing = listSpaces(db).find((s) => s.name === SPACE_NAME && s.kind === "markets" && s.status === "active");
  const space = existing ?? createSpace(db, { name: SPACE_NAME, kind: "markets", goal: GOAL, private: true });
  return { spaceId: space.id, created: !existing };
}
