import type { Person } from "./types";

// Accounts are keyed by address, so "Sam@Example.com " and "sam@example.com" are one account.
export const normalizeAddress = (a: string): string => a.trim().toLowerCase();

// No format, control, bidi, zero-width or unassigned characters anywhere: the address the card shows must be the
// address mail goes to.
const UNSEEN = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
export const isAddress = (a: string): boolean => !UNSEEN.test(a) && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(a.trim());

// RFC 2047 encoded words ("=?UTF-8?Q?Ren=C3=A9?=", "=?ISO-8859-1?B?…?="), as raw headers from Mail.app carry them.
// Whitespace between two encoded words is dropped, as the RFC says; a charset the runtime can't decode stays as is.
export function decodeWords(text: string, clean: (decoded: string) => string = (d) => d): string {
  return text
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(data, "base64")
            : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
        return clean(new TextDecoder(charset.split("*")[0]!).decode(bytes));
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

// Split on commas outside quotes and angle brackets.
// A header's people. The raw header is split and each address read before anything is decoded, and only display
// names are decoded: an encoded word can't add a person or change an address by decoding to "<…>" or a comma.
export function parseAddressList(raw: string | null | undefined): Person[] {
  return splitAddresses(raw).map((p) => ({ ...p, name: displayText(p.name) }));
}

// A display name with its encoded words decoded, minus any address syntax the decoding itself produced. Quotes and
// commas the sender wrote in plain text ("Vale, Robin") stay.
const displayText = (name: string): string =>
  decodeWords(name, (d) => d.replace(/[<>,"]/g, ""))
    .replace(/\s+/g, " ")
    .trim();

function splitAddresses(header: string | null | undefined): Person[] {
  if (!header) return [];
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
