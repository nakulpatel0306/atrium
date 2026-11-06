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

export function textProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return EMPTY_COPY;
  if (CONTROL.test(t) || new RegExp(HIDDEN_TEXT.source).test(t)) return HIDDEN_COPY;
  if (textLength(t) > MAX_TEXT) return TOO_LONG_COPY;
  return null;
}

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
