import type { Database } from "bun:sqlite";
import { setMessagingState } from "../capabilities";
import { stripHidden } from "../repos/rules";
import { runOsa } from "./osascript";
import { findProblem } from "./problems";
import { MAX_NAME, maskHandle, memberNames, nameProblem, normalizeHandle, peopleLine } from "./rules";
import { CHATS_SCRIPT } from "./scripts";
import { getMessageAction, type Group, type GroupChat, setGroupChat } from "./store";

const RS = String.fromCharCode(30);
const US = String.fromCharCode(31);
const GS = String.fromCharCode(29);
const FS = String.fromCharCode(28);

// The most chats a card lists, those matching Nakul's own words first.
export const MAX_SHOWN = 20;

const plain = (s: string) => stripHidden(s.replace(/[\u0000-\u001f\u007f]/g, "")).trim();

// A name from Messages (a chat's name, a member's Contacts name) is shown only if it passes the same rule as the
// agent's names, so it can't read as a separator, a number or a second group. Otherwise it's left out: the chat shows
// as unnamed, the member by masked handle.
export function messagesName(raw: string): string | null {
  const t = [...plain(raw)].slice(0, MAX_NAME).join("");
  if (!t || t === "missing value" || nameProblem(t) || normalizeHandle(t)) return null;
  return t;
}

// The ids Messages gives chats: service, ";+;" for a group (";-;" for one person), then the chat's own key.
const CHAT_ID = /^(iMessage|SMS|RCS|any);[-+];\S{1,180}$/;
const SKIPPED = "ATRIUM_SKIPPED";

// Handles are checked and masked here, so a raw number or email never leaves the parser. A record that doesn't read
// cleanly (wrong field count, an id or handle in the wrong shape, an id seen twice) is dropped whole and counted with
// the chats the script itself couldn't read.
export function parseChats(out: string): { chats: GroupChat[]; skipped: number } {
  const chats: GroupChat[] = [];
  let skipped = 0;
  for (const rec of out.replace(/\n$/, "").split(RS)) {
    if (!rec) continue;
    const f = rec.split(US);
    if (f.length === 2 && f[0] === SKIPPED) {
      skipped += Number.parseInt(f[1]!, 10) || 0;
      continue;
    }
    const chat = f.length === 4 ? chatOf(f as [string, string, string, string]) : null;
    if (chat === "not-a-group") continue;
    if (chat) chats.push(chat);
    else skipped++;
  }
  const seen = new Map<string, number>();
  for (const c of chats) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  const unique = chats.filter((c) => seen.get(c.id) === 1);
  return { chats: unique, skipped: skipped + chats.length - unique.length };
}

// A group everyone else has left reads fine but can't take a group text: it's left out, not counted as unreadable.
function chatOf([rawId, rawName, svc, members]: [string, string, string, string]): GroupChat | "not-a-group" | null {
  const id = plain(rawId);
  if (!CHAT_ID.test(id)) return null;
  const parts = members ? members.split(GS).map((m) => m.split(FS)) : [];
  if (parts.some((p) => p.length !== 2)) return null;
  if (parts.length < 2) return "not-a-group";
  const handles = parts.map((p) => normalizeHandle(plain(p[0]!)));
  if (handles.some((h) => !h)) return null;
  return {
    id,
    name: messagesName(rawName),
    // Messages' other services (RCS) send like SMS for what the card needs to say.
    service: plain(svc) === "iMessage" ? "iMessage" : "SMS",
    participants: parts.map((p, i) => ({ name: messagesName(p[1]!), handle: maskHandle(handles[i]!) })),
  };
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

const label = (c: GroupChat) => (c.name ? `"${c.name}"` : "the unnamed group");

// A chat is picked only on its members: at least one person named, each one a different member, and nobody else in
// it. A chat's name is set by anyone in it, so a name alone only ranks the list. When several chats have exactly those
// people, his name for the group can tell them apart.
export function matchChats(chats: GroupChat[], ask: Pick<Group, "name" | "people">, skipped = 0): ChatMatch {
  const scored = chats.map((chat) => ({ chat, name: nameScore(ask.name, chat), ...peopleFit(ask.people, chat) }));
  const exact = ask.people.length ? scored.filter((s) => s.matched === ask.people.length && s.extra === 0) : [];
  const exactNamed = exact.filter((s) => s.name === 3);
  const picked = exact.length === 1 ? exact[0]!.chat : exactNamed.length === 1 ? exactNamed[0]!.chat : null;
  const ranked = [...scored].sort((a, b) => b.name - a.name || b.matched - a.matched || (ask.people.length ? a.extra - b.extra : 0) || (a.chat.name ?? "").localeCompare(b.chat.name ?? ""));
  const shown = ranked.slice(0, MAX_SHOWN).map((s) => s.chat);
  const unread = skipped > 0 ? ` Atrium couldn't read ${skipped} chat${skipped === 1 ? "" : "s"}.` : "";
  if (picked) return { shown, picked, message: `${pickedCopy(picked, ask.people)}${unread}` };
  const named = scored.filter((s) => s.name === 3).map((s) => s.chat);
  const close = scored.filter((s) => s.name > 0 || s.matched > 0).length;
  return { shown, picked: null, message: `${noPickCopy(ask, chats.length, close, named)}${unread}` };
}

export const pickedCopy = (c: GroupChat, people: string[]) => `Picked ${label(c)} because its members are exactly ${peopleLine(people)}.`;

export function noPickCopy(ask: Pick<Group, "name" | "people">, total: number, close: number, named: GroupChat[] = []): string {
  const who = ask.name ? `"${ask.name}"` : peopleLine(ask.people);
  const apart = ask.people.length > 1 ? " send the text to each person separately" : "";
  if (total === 0) return `Messages has no group chats on this Mac.${apart ? ` You can${apart} instead.` : ""}`;
  if (named.length === 1) return `Found 1 group chat named ${who} in Messages: ${memberNames({ name: null, people: [], chat: named[0]! }).join(", ")}. Pick it if that's who you mean.`;
  if (named.length > 1) return `Found ${named.length} group chats named ${who} in Messages. Pick the one with the right people.`;
  if (close > 1) return `More than one group chat could be ${who}. Pick the right one.`;
  if (close === 1) return `No group chat is exactly ${who}. The closest one is first. Pick it if it's right.`;
  return `No group chat in Messages matches ${who}. Pick one below${apart ? `, or${apart}` : ""}.`;
}

// Reads Messages' chat list, only when Nakul presses Find. A single clear match goes on a draft that has no chat yet
// (one he picked himself is never replaced); the rest is only returned for him to pick from, never stored or shown to
// an agent.
export async function findChats(db: Database, actionId: string, opts: { timeoutMs?: number } = {}): Promise<ChatMatch> {
  const action = getMessageAction(db, actionId);
  if (!action?.group) throw new Error(`No group text draft with id ${actionId}`);
  const res = await runOsa(CHATS_SCRIPT, [], opts);
  if (res.code !== 0 || res.timedOut) {
    const problem = findProblem(res);
    if (problem.kind === "automation_denied") setMessagingState(db, "needs_automation");
    throw problem;
  }
  const { chats, skipped } = parseChats(res.out);
  const match = matchChats(chats, action.group, skipped);
  if (!match.picked) return match;
  if (action.group.chat) return { ...match, picked: null, message: `Find matched ${label(match.picked)}: its members are exactly ${peopleLine(action.group.people)}. Pick it below to use it instead of the chat on this text.` };
  setGroupChat(db, actionId, match.picked);
  return match;
}
