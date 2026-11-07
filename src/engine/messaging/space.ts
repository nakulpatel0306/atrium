import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { config } from "../config";
import { finishPendingDeletes, queueDelete } from "../delete-files";
import { tildePath } from "../folders";
import { bus, logActivity } from "../events";
import { getSetting, setSetting } from "../settings";
import { createSpace, getSpace, type Space } from "../spaces";

const NAME = "Messages";
const GOAL = "Texts Atrium drafted for you. Each one is sent only after you press Send.";

// One space holds every text asked for from the command bar, so sent history lives in one place.
export function messagesSpace(db: Database): Space {
  const id = getSetting(db, "messaging.spaceId");
  const found = id ? getSpace(db, id) : null;
  if (found?.status === "active") return found;
  const space = createSpace(db, { name: NAME, kind: "general", goal: GOAL, color: "#4cb782", private: true });
  setSetting(db, "messaging.spaceId", space.id);
  return space;
}

// Tables a Messages space fills; anything else in it (investing data, say) means it isn't only texts.
const MOVED = ["tasks", "approvals", "activity", "messages", "message_actions", "run_files", "rule_events", "autonomy_proposals", "autonomy_rules", "repo_actions"];
const OTHER = ["market_lists", "market_watchlist", "market_holdings", "market_alerts", "paper_accounts", "paper_fills", "market_strategies", "research_notes", "market_writeups", "market_ideas", "money_transactions"];

const pinOf = (db: Database, id: string) => db.query("SELECT folder_dev AS dev, folder_ino AS ino FROM spaces WHERE id = ?").get(id) as { dev: number | null; ino: number | null };

// Archiving Messages makes a fresh one with the next text. Restoring the old one would leave two, so its history
// moves into the current one instead. Returns the space that's now Messages, or null when this isn't that case.
// The earlier Messages space and the current one, when restoring `id` would make a second Messages; else null.
function duplicateOf(db: Database, id: string): { old: Space; current: Space } | null {
  const old = getSpace(db, id);
  const currentId = getSetting(db, "messaging.spaceId");
  const current = currentId && currentId !== id ? getSpace(db, currentId) : null;
  if (!old || old.status !== "archived" || old.name !== NAME || old.goal !== GOAL || current?.status !== "active") return null;
  if (OTHER.some((t) => db.query(`SELECT 1 FROM ${t} WHERE space_id = ?`).get(id))) return null;
  return { old, current };
}

// A run still going in the earlier space would write its draft and files to a space that's gone once merged.
export function messagesMergeWait(db: Database, id: string): string | null {
  if (!duplicateOf(db, id)) return null;
  const busy =
    db.query("SELECT 1 FROM tasks WHERE space_id = ? AND status = 'running'").get(id) ??
    db.query("SELECT 1 FROM message_actions WHERE space_id = ? AND status = 'sending'").get(id);
  return busy ? "A text is still being drafted in the earlier Messages space. Try again once it's done." : null;
}

export function mergeRestoredMessages(db: Database, id: string): Space | null {
  const pair = duplicateOf(db, id);
  if (!pair || messagesMergeWait(db, id)) return null;
  const { old, current } = pair;
  db.transaction(() => {
    const pin = pinOf(db, id);
    for (const t of MOVED) db.query(`UPDATE ${t} SET space_id = ? WHERE space_id = ?`).run(current.id, id);
    db.query("UPDATE repo_clones SET space_id = ? WHERE space_id = ?").run(current.id, id);
    db.query("DELETE FROM spaces WHERE id = ?").run(id);
    // Its folder goes with it only while empty; files in it are Nakul's to move.
    const empty = old.folder && (!existsSync(old.folder) || readdirSync(old.folder).length === 0);
    if (empty) queueDelete(db, "folder", old.folder!, config().filesHome, pin);
    const kept = old.folder && !empty ? ` Its folder ${tildePath(old.folder)} still has files, so it stays where it is.` : "";
    logActivity(db, current.id, "atrium", `Moved the earlier Messages space's texts and history into this one.${kept}`);
  })();
  void finishPendingDeletes(db).catch((e) => console.error("Couldn't remove the earlier Messages folder:", e));
  bus.emit({ type: "changed" });
  return getSpace(db, current.id);
}
