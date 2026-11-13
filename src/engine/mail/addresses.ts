import type { Person } from "./types";

// Accounts are keyed by address, so "Sam@Example.com " and "sam@example.com" are one account.
export const normalizeAddress = (a: string): string => a.trim().toLowerCase();

export const isAddress = (a: string): boolean => /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(a.trim());

// RFC 2047 encoded words ("=?UTF-8?Q?Ren=C3=A9?=", "=?ISO-8859-1?B?…?="), as raw headers from Mail.app carry them.
// Whitespace between two encoded words is dropped, as the RFC says; a charset the runtime can't decode stays as is.
export function decodeWords(text: string): string {
  return text
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(data, "base64")
            : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
        return new TextDecoder(charset.split("*")[0]!).decode(bytes);
      } catch {
        return whole;
      }
    });
}

// One "Name <a@b>" or bare "a@b". Display names lose their quotes; an unparseable entry keeps its text as the name.
function parseOne(raw: string): Person | null {
  const s = raw.trim();
  if (!s) return null;
  const angled = s.match(/^(.*)<([^<>]+)>\s*$/);
  if (angled) {
    const name = angled[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1");
    return { name, address: normalizeAddress(angled[2]!) };
  }
  return isAddress(s) ? { name: "", address: normalizeAddress(s) } : { name: s, address: "" };
}

// A header's address list, split on commas outside quotes and angle brackets.
export function parseAddressList(raw: string | null | undefined): Person[] {
  if (!raw) return [];
  const header = decodeWords(raw);
  const out: Person[] = [];
  let cur = "";
  let quoted = false;
  let angled = false;
  for (const c of header) {
    if (c === '"') quoted = !quoted;
    else if (c === "<" && !quoted) angled = true;
    else if (c === ">" && !quoted) angled = false;
    if (c === "," && !quoted && !angled) {
      const p = parseOne(cur);
      if (p) out.push(p);
      cur = "";
    } else cur += c;
  }
  const p = parseOne(cur);
  if (p) out.push(p);
  return out;
}

export const parsePerson = (header: string | null | undefined): Person => parseAddressList(header)[0] ?? { name: "", address: "" };

// "<a@b>" message ids from a References or In-Reply-To header, in order.
export const parseIds = (header: string | null | undefined): string[] => (header ? [...header.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]) : []);

// "Re: Fwd: RE: Lease" → "lease", for the same-participants fallback when a reply carries no threading headers.
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^(re|fwd?|aw|sv|antw)(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").toLowerCase();
}
