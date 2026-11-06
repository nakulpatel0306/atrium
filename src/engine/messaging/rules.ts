import { HIDDEN_TEXT } from "../repos/rules";

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

// A zero-width joiner inside an emoji sequence (👨‍👩‍👧) is how the emoji is spelled, not hidden text.
const EMOJI_JOINER = /(\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/gu;

export function textProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return EMPTY_COPY;
  if (CONTROL.test(t) || new RegExp(HIDDEN_TEXT.source).test(t.replace(EMOJI_JOINER, "$1"))) return HIDDEN_COPY;
  if (textLength(t) > MAX_TEXT) return TOO_LONG_COPY;
  return null;
}

export const MAX_NAME = 80;
export const NAME_COPY = "Say who the message is for in one line, under 80 characters, with no hidden characters.";

// The name sits on the card next to the number, so it can't carry line breaks or direction marks that would make
// the card read as someone else.
export function nameProblem(name: string): string | null {
  const t = name.trim();
  if (!t || [...t].length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(t) || new RegExp(HIDDEN_TEXT.source).test(t)) return NAME_COPY;
  return null;
}

// One plain line, for text Atrium itself shows on the card (an earlier failure).
export const oneLine = (text: string): string =>
  text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(new RegExp(HIDDEN_TEXT.source, "g"), "").replace(/ {2,}/g, " ").trim().slice(0, 400);

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
