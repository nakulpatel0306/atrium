import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "../settings";
import { createSpace, getSpace, type Space } from "../spaces";

// One space holds every text asked for from the command bar, so sent history lives in one place.
export function messagesSpace(db: Database): Space {
  const id = getSetting(db, "messaging.spaceId");
  const found = id ? getSpace(db, id) : null;
  if (found?.status === "active") return found;
  const space = createSpace(db, {
    name: "Messages",
    kind: "general",
    goal: "Texts Atrium drafted for you. Each one is sent only after you press Send.",
    color: "#4cb782",
    private: true,
  });
  setSetting(db, "messaging.spaceId", space.id);
  return space;
}
