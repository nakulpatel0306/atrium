import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "../settings";
import { createSpace, getSpace, type Space } from "../spaces";

const NAME = "Inbox";
const GOAL = "Your mail and calendar, read on this Mac. Ask about a thread or your week; nothing is sent without your yes.";
const KEY = "mail.spaceId";

// The one private space mail and calendar live in. Made by Get started or the first account connected; an archived
// one is left alone and a fresh one made, as Messages does.
export function inboxSpace(db: Database): Space {
  const id = getSetting(db, KEY);
  const found = id ? getSpace(db, id) : null;
  if (found?.status === "active") return found;
  const space = createSpace(db, { name: NAME, kind: "inbox", goal: GOAL, color: "#5e9fe0", private: true });
  setSetting(db, KEY, space.id);
  return space;
}

export function inboxSpaceId(db: Database): string | null {
  const id = getSetting(db, KEY);
  return id && getSpace(db, id)?.status === "active" ? id : null;
}
