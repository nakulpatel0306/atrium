import { hasHidden, stripHidden } from "../repos/rules";
import type { Group } from "./store";

// The message rules with no file system or database access, so the dashboard checks a draft with the engine's
// exact wording.
export const MAX_TEXT = 2000;

export const EMPTY_COPY = "Write the message first.";
export const TOO_LONG_COPY = "Keep the message under 2,000 characters.";
export const HIDDEN_COPY = "The message has hidden characters that could make it read differently from what's sent. Remove them and try again.";
export const BAD_HANDLE_COPY =
  "That doesn't look like a phone number or email. Phone numbers use digits with an optional + in front, like +1 416 555 0134.";

// Newlines and tabs are part of a normal text; any other control character or direction mark is not.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PHONE = /^\+?[0-9]{7,15}$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;

// Counted in characters as people see them, so an emoji is one, as in the card's counter.
export const textLength = (text: string): number => [...text.trim()].length;

// How emoji are spelled, not hidden text: one variation selector straight after an emoji or keycap base (❤️, 1️⃣),
// a zero-width joiner between two emoji (👨‍👩‍👧, 🏳️‍🌈), and a flag's own tag sequence (🏴 + letters + cancel tag).
// They're taken out before the check; anything left over (a second selector, a joiner between letters, loose tag
// characters) is refused.
const EMOJI_SELECTOR = /(\p{Extended_Pictographic}|[0-9#*])[\uFE0E\uFE0F]/gu;
const EMOJI_JOINER = /(\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic})/gu;
const FLAG_TAGS = /\u{1F3F4}[\u{E0061}-\u{E007A}]{2,7}\u{E007F}/gu;
const withoutEmojiSpelling = (t: string) => t.replace(FLAG_TAGS, "\u{1F3F4}").replace(EMOJI_SELECTOR, "$1").replace(EMOJI_JOINER, "$1");

// Control characters or direction marks that would make what's shown differ from what's sent. Emoji spelling is fine.
export const hasHiddenText = (t: string): boolean => CONTROL.test(t) || hasHidden(withoutEmojiSpelling(t));

export function textProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return EMPTY_COPY;
  if (hasHiddenText(t)) return HIDDEN_COPY;
  if (textLength(t) > MAX_TEXT) return TOO_LONG_COPY;
  return null;
}

export const MAX_NAME = 80;
export const NAME_COPY =
  "Say who the message is for in one line, under 80 characters, with no hidden characters. Put a phone number or email in the number field, not in the name.";

// The name sits on the card next to the number, so it can't carry line breaks or direction marks that would make
// the card read as someone else.
// A name that is itself a number or email is fine (the card still asks for the number). One that mixes a name with a
// separator, an email or a long digit run could pose as a second recipient next to the real number.
export function nameProblem(name: string): string | null {
  const t = name.trim();
  if (!t || [...t].length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(t) || hasHidden(t)) return NAME_COPY;
  if (normalizeHandle(t)) return null;
  if (/[·•|]/.test(t) || /@[^\s]+\.[A-Za-z]{2,}/.test(t) || (t.match(/\d/g)?.length ?? 0) >= 7) return NAME_COPY;
  return null;
}

// One plain line, for text Atrium itself shows on the card (an earlier failure).
export const oneLine = (text: string): string =>
  stripHidden(text.replace(/[\u0000-\u001f\u007f]+/g, " ")).replace(/ {2,}/g, " ").trim().slice(0, 400);

// The only recipients Atrium ever hands to Messages: a phone number of digits, or a plain email address.
export function normalizeHandle(raw: string): string | null {
  const t = raw.trim();
  if (t.includes("@")) return EMAIL.test(t) ? t : null;
  const digits = t.replace(/[  ().-]/g, "");
  return PHONE.test(digits) ? digits : null;
}

export const handleProblem = (raw: string): string | null => (normalizeHandle(raw) ? null : BAD_HANDLE_COPY);

export function displayHandle(h: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(h);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : h;
}

// A group chat member's handle as the card shows it: enough to tell two people apart, not enough to copy.
export function maskHandle(raw: string): string {
  const t = plainLine(raw);
  const at = t.indexOf("@");
  if (at > 0) return `${t[0]}••@${t.slice(at + 1)}`;
  const digits = t.replace(/[^0-9]/g, "");
  if (digits.length < 4) return "••••";
  return `${t.startsWith("+") && digits.startsWith("1") && digits.length === 11 ? "+1 ••• ••• " : "••• "}${digits.slice(-4)}`;
}

const plainLine = (s: string) => stripHidden(s.replace(/[\u0000-\u001f\u007f]/g, "")).trim();

export const MAX_PEOPLE = 12;

// How a group with no chat name yet reads on the card: "Sam, Priya and Jo", shortened to stay one name.
export function peopleLine(people: readonly string[]): string {
  if (people.length <= 1) return people[0] ?? "";
  const all = `${people.slice(0, -1).join(", ")} and ${people.at(-1)}`;
  const short = `${people[0]}, ${people[1]} and ${people.length - 2} other${people.length === 3 ? "" : "s"}`;
  for (const line of [all, short]) if ([...line].length <= MAX_NAME) return line;
  return `${people.length} people`;
}

// The chat's own name once Find picked it, else what the agent called the group.
export function groupTitle(toName: string, g: Group): string {
  if (!g.chat) return toName;
  return g.chat.name ?? (g.chat.participants.length ? peopleLine(memberNames(g)) : toName);
}

// Who's in the group: the picked chat's members (a masked handle stands in for an unnamed one), else whom the agent named.
export const memberNames = (g: Group): string[] => (g.chat ? g.chat.participants.map((p) => p.name ?? p.handle) : g.people);

// What the agent asked for, shown beside whatever Messages calls the chat it picked.
export const askLine = (g: Group): string => [g.name ? `"${g.name}"` : null, g.people.length ? peopleLine(g.people) : null].filter(Boolean).join(" with ");

// Whom a text goes to as the cards say it, and whether it has somewhere to go yet (a number, or a picked chat).
export const recipientOf = (m: { toName: string; group: Group | null }): string => (m.group ? groupTitle(m.toName, m.group) : m.toName);
export const hasTarget = (m: { handle: string | null; group: Group | null }): boolean => (m.group ? m.group.chat !== null : m.handle !== null);

export const NO_NAME_COPY = "Messages has no Contacts name for them, so Atrium can't look up their number. Text them yourself.";

// Who "Send separately" texts: exactly the people the card shows (the picked chat's members, else whom the agent
// named). A member known only by masked handle can't get a text of their own, so they're listed with why, never
// dropped quietly.
export function separatePlan(g: Group): { people: string[]; skipped: { who: string; why: string }[] } {
  if (!g.chat) return { people: g.people, skipped: [] };
  return {
    people: g.chat.participants.flatMap((p) => (p.name ? [p.name] : [])),
    skipped: g.chat.participants.flatMap((p) => (p.name ? [] : [{ who: p.handle, why: NO_NAME_COPY }])),
  };
}
