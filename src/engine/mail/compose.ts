import { hasHiddenText } from "../messaging/rules";
import { isAddress, normalizeAddress, parseAddressList } from "./addresses";
import type { Person } from "./types";

// The draft rules with no file system or database access, so the dashboard checks an email or event card with the
// engine's exact wording.

export type MailKind = "reply" | "reply_all" | "forward" | "new";
export type EventKind = "event_create" | "event_move" | "event_cancel";
export type ActionKind = MailKind | EventKind;
// added: Claude put this person on the card; they weren't on the thread it answers.
export type Recipient = Person & { added: boolean };
export type ReasonKind = "first_time" | "outside_thread" | "attachments" | "other_account" | "many" | "may_notify";
// Why a draft needs the user's explicit Send, shown on the card as a note. key names what it's about (the kind and
// the address), so the fresh-Send check compares people, not wording.
export type Reason = { kind: ReasonKind; key: string; text: string };

export const isEvent = (k: ActionKind): k is EventKind => k.startsWith("event_");

// More than this many people on one email or invite needs the explicit Send.
export const MANY_RECIPIENTS = 10;
export const MAX_RECIPIENTS = 50;
export const MAX_BODY = 50_000;
export const MAX_SUBJECT = 300;

export const NO_TO_COPY = "Add who this goes to first.";
export const TOO_MANY_COPY = `An email from Atrium goes to at most ${MAX_RECIPIENTS} people.`;
export const BODY_HIDDEN_COPY = "The email has hidden characters that could make it read differently from what's sent. Remove them and try again.";
export const BODY_EMPTY_COPY = "Write the email first.";
export const BODY_LONG_COPY = "Keep the email under 50,000 characters.";
export const SUBJECT_COPY = "Keep the subject to one line under 300 characters, with no hidden characters.";
export const badAddressCopy = (a: string) => `"${a}" isn't an email address. Use the form name@example.com.`;

// "Robin Vale <robin@example.net>, kit@example.org" as typed on the card. Anything that isn't an address is an
// error the card shows, never a guess.
export function parseRecipients(text: string): { people: Person[]; problem: string | null } {
  const people = parseAddressList(text);
  const bad = people.find((p) => !isAddress(p.address));
  return { people: bad ? [] : people, problem: bad ? badAddressCopy(bad.name || bad.address) : null };
}

export function recipientsProblem(to: Person[], cc: Person[]): string | null {
  if (to.length === 0) return NO_TO_COPY;
  const bad = [...to, ...cc].find((p) => !isAddress(p.address) || /[\r\n]/.test(p.name) || hasHiddenText(p.name));
  if (bad) return badAddressCopy(bad.address || bad.name);
  if (to.length + cc.length > MAX_RECIPIENTS) return TOO_MANY_COPY;
  return null;
}

// A forward may go with no note of its own; anything else needs words.
export function bodyProblem(body: string, kind: ActionKind): string | null {
  const t = body.trim();
  if (!t && kind !== "forward") return BODY_EMPTY_COPY;
  if (t && hasHiddenText(t.replace(/\t/g, " "))) return BODY_HIDDEN_COPY;
  if (t.length > MAX_BODY) return BODY_LONG_COPY;
  return null;
}

export function subjectProblem(subject: string): string | null {
  const t = subject.trim();
  return t.length > MAX_SUBJECT || hasHiddenText(t) ? SUBJECT_COPY : null;
}

// "Re: Lease renewal", without stacking prefixes the subject already has.
export function subjectFor(kind: MailKind, original: string): string {
  const s = original.trim();
  if (kind === "forward") return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
  if (kind === "reply" || kind === "reply_all") return /^re:/i.test(s) ? s : `Re: ${s}`;
  return s;
}

// A display name as one plain line: invisible and direction characters from a sender's header are dropped, so the
// card can't read differently from what's sent.
export const plainName = (name: string): string => name.replace(/[\p{Cf}\p{Cc}]/gu, "").replace(/\s+/g, " ").trim();

// One list of people with each address once, the first spelling kept.
export function uniquePeople<T extends Person>(people: T[], skip: Set<string> = new Set()): T[] {
  const seen = new Set(skip);
  const out: T[] = [];
  for (const p of people) {
    const a = normalizeAddress(p.address);
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push({ ...p, name: plainName(p.name), address: a });
  }
  return out;
}

// Whom a reply goes to, from the message's own headers and nothing else. Answering someone else's message goes to its
// sender (reply all: plus everyone else on it); answering one of your own goes to whoever you sent it to.
export function replyRecipients(own: Set<string>, m: { from: Person; to: Person[]; cc: Person[] }, kind: "reply" | "reply_all"): { to: Person[]; cc: Person[] } {
  const mine = own.has(normalizeAddress(m.from.address));
  if (mine) {
    const to = uniquePeople(m.to, own);
    return { to, cc: kind === "reply_all" ? uniquePeople(m.cc, new Set([...own, ...to.map((p) => p.address)])) : [] };
  }
  const to = uniquePeople(kind === "reply_all" ? [m.from, ...m.to] : [m.from], own);
  return { to, cc: kind === "reply_all" ? uniquePeople(m.cc, new Set([...own, ...to.map((p) => p.address)])) : [] };
}

// The card's people after the user's edits: someone Claude added stays marked while they're still there; anyone the
// user typed is his own.
export function markAdded(people: Person[], before: Recipient[]): Recipient[] {
  const added = new Set(before.filter((p) => p.added).map((p) => normalizeAddress(p.address)));
  return uniquePeople(people).map((p) => ({ ...p, added: added.has(p.address) }));
}

// A person as the card and notes name them: always with the address, since a name is whatever the sender or Claude
// chose.
export const personLabel = (p: Person): string => (p.name && p.name !== p.address ? `${p.name} <${p.address}>` : p.address);

// "robin@example.net", "Robin Vale <robin@example.net> and kit@example.org", "… and 3 others".
export function namesLine(people: Person[]): string {
  if (!people.length) return "no one yet";
  const first = personLabel(people[0]!);
  if (people.length === 1) return first;
  if (people.length === 2) return `${first} and ${personLabel(people[1]!)}`;
  return `${first} and ${people.length - 1} others`;
}

export const KIND_NOUN: Record<ActionKind, string> = {
  reply: "reply",
  reply_all: "reply",
  forward: "forward",
  new: "email",
  event_create: "invite",
  event_move: "event change",
  event_cancel: "cancellation",
};
