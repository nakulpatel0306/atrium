import type { Database } from "bun:sqlite";
import { setMessagingState } from "../capabilities";
import { stripHidden } from "../repos/rules";
import { runOsa } from "./osascript";
import { findProblem } from "./problems";
import { MAX_NAME, maskHandle, peopleLine } from "./rules";
import { CHATS_SCRIPT } from "./scripts";
import { getMessageAction, type Group, type GroupChat, setGroupChat } from "./store";

const RS = String.fromCharCode(30);
const US = String.fromCharCode(31);
const GS = String.fromCharCode(29);
const FS = String.fromCharCode(28);

// The most chats a card lists, those matching Nakul's own words first.
export const MAX_SHOWN = 20;

const plain = (s: string) => stripHidden(s.replace(/[\u0000-\u001f\u007f]/g, "")).trim();
const named = (s: string) => {
  const t = plain(s);
  return t && t !== "missing value" ? [...t].slice(0, MAX_NAME).join("") : null;
};

// Handles are masked here, so a raw number or email never leaves the parser. A record with the wrong number of
// fields (a separator inside a name) is dropped whole.
export function parseChats(out: string): GroupChat[] {
  const chats: GroupChat[] = [];
  for (const rec of out.replace(/\n$/, "").split(RS)) {
    const f = rec.split(US);
    if (f.length !== 4) continue;
    const [rawId, rawName, svc, members] = f as [string, string, string, string];
    const id = plain(rawId);
    if (!id || id.length > 200) continue;
    const parts = members.split(GS).map((m) => m.split(FS));
    if (parts.length < 2 || parts.some((p) => p.length !== 2 || !plain(p[0]!))) continue;
    chats.push({
      id,
      name: named(rawName),
      // Messages' other services (RCS) send like SMS for what the card needs to say.
      service: plain(svc) === "iMessage" ? "iMessage" : "SMS",
      participants: parts.map(([handle, name]) => ({ name: named(name!), handle: maskHandle(handle!) })),
    });
  }
  return chats;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (s: string) => norm(s).split(" ").filter(Boolean);
const FILLER = new Set(["the", "group", "chat", "and", "gc"]);

// 3 the chat's name is his words, 2 one holds the other, 1 they share a word, 0 nothing.
function nameScore(want: string | null, chat: GroupChat): number {
  if (!want || !chat.name) return 0;
  const [w, h] = [norm(want), norm(chat.name)];
  if (!w || !h) return 0;
  if (w === h) return 3;
  if (h.includes(w) || w.includes(h)) return 2;
  const mine = new Set(words(want).filter((x) => x.length > 2 && !FILLER.has(x)));
  return words(chat.name).some((x) => mine.has(x)) ? 1 : 0;
}

// "Sam" is Sam Lee; "Sam Lee" is Sam Lee; "Sam" isn't Samantha.
const isPerson = (want: string, have: string | null) => {
  if (!have) return false;
  const h = new Set(words(have));
  const w = words(want);
  return w.length > 0 && w.every((x) => h.has(x));
};

// How many of the people he named are in the chat, each matched to a different member, and how many members are extra.
function peopleFit(people: string[], chat: GroupChat): { matched: number; extra: number } {
  const free = [...chat.participants];
  let matched = 0;
  for (const person of people) {
    const i = free.findIndex((p) => isPerson(person, p.name));
    if (i < 0) continue;
    free.splice(i, 1);
    matched++;
  }
  return { matched, extra: free.length };
}

export type ChatMatch = { shown: GroupChat[]; picked: GroupChat | null; message: string | null };

export function matchChats(chats: GroupChat[], ask: Pick<Group, "name" | "people">): ChatMatch {
  const scored = chats.map((chat) => ({ chat, name: nameScore(ask.name, chat), ...peopleFit(ask.people, chat) }));
  const hasAll = (s: (typeof scored)[number]) => s.matched === ask.people.length;
  // One chat with exactly his name (holding everyone he named), else one chat of exactly the people he named.
  const byName = scored.filter((s) => s.name === 3 && hasAll(s));
  const byPeople = ask.people.length ? scored.filter((s) => hasAll(s) && s.extra === 0) : [];
  const picked = byName.length === 1 ? byName[0]!.chat : byName.length === 0 && byPeople.length === 1 ? byPeople[0]!.chat : null;
  const ranked = [...scored].sort((a, b) => b.name - a.name || b.matched - a.matched || (ask.people.length ? a.extra - b.extra : 0) || (a.chat.name ?? "").localeCompare(b.chat.name ?? ""));
  const shown = ranked.slice(0, MAX_SHOWN).map((s) => s.chat);
  return { shown, picked, message: picked ? null : noPickCopy(ask, chats.length, ranked.filter((s) => s.name > 0 || s.matched > 0).length) };
}

export function noPickCopy(ask: Pick<Group, "name" | "people">, total: number, close: number): string {
  const who = ask.name ? `"${ask.name}"` : peopleLine(ask.people);
  const apart = ask.people.length > 1 ? " send the text to each person separately" : "";
  if (total === 0) return `Messages has no group chats on this Mac.${apart ? ` You can${apart} instead.` : ""}`;
  if (close > 1) return `More than one group chat could be ${who}. Pick the right one.`;
  if (close === 1) return `No group chat is exactly ${who}. The closest one is first. Pick it if it's right.`;
  return `No group chat in Messages matches ${who}. Pick one below${apart ? `, or${apart}` : ""}.`;
}

// Reads Messages' chat list, only when Nakul presses Find. A single clear match goes on the draft; the rest is only
// returned for him to pick from, never stored or shown to an agent.
export async function findChats(db: Database, actionId: string, opts: { timeoutMs?: number } = {}): Promise<ChatMatch> {
  const action = getMessageAction(db, actionId);
  if (!action?.group) throw new Error(`No group text draft with id ${actionId}`);
  const res = await runOsa(CHATS_SCRIPT, [], opts);
  if (res.code !== 0 || res.timedOut) {
    const problem = findProblem(res);
    if (problem.kind === "automation_denied") setMessagingState(db, "needs_automation");
    throw problem;
  }
  const match = matchChats(parseChats(res.out), action.group);
  if (match.picked) setGroupChat(db, actionId, match.picked);
  return match;
}
