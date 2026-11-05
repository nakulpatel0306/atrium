import { strFromU8, unzipSync } from "fflate";
import { FundFileError } from "./types";

const UNREADABLE = "That holdings file isn't a spreadsheet Atrium can read.";
const TOO_LARGE = "That holdings file is too large to be a holdings spreadsheet.";
// A real SPY sheet inflates to well under 1 MB; anything near this is a zip bomb, refused before inflating.
const MAX_PART_BYTES = 50 * 1024 * 1024;

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

// All the text runs of one string item (rich text is split into several <t>).
const texts = (xml: string) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

const columnIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// One sheet of an .xlsx as a grid of strings: shared, inline and numeric cells, blanks kept in place. Enough for
// one issuer file; anything fancier isn't needed.
export function readXlsxRows(bytes: Uint8Array, sheet = 0): string[][] {
  const wanted = new Set(["xl/sharedStrings.xml", `xl/worksheets/sheet${sheet + 1}.xml`]);
  let tooLarge = false;
  let files: Record<string, Uint8Array>;
  try {
    // Only the two parts Atrium reads are inflated, and only when their declared size is sane.
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!wanted.has(f.name)) return false;
        if (f.originalSize >= MAX_PART_BYTES) {
          tooLarge = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    throw new FundFileError(UNREADABLE);
  }
  if (tooLarge) throw new FundFileError(TOO_LARGE);
  const sheetXml = files[`xl/worksheets/sheet${sheet + 1}.xml`];
  if (!sheetXml) throw new FundFileError(UNREADABLE);
  try {
    const sharedXml = files["xl/sharedStrings.xml"];
    const shared = sharedXml ? [...strFromU8(sharedXml).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!)) : [];
    const rows: string[][] = [];
    for (const row of strFromU8(sheetXml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const out: string[] = [];
      for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const body = c[2] ?? "";
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const type = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const value = type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? texts(body) : v !== undefined ? decode(v) : "";
        const i = ref ? columnIndex(ref) : out.length;
        while (out.length < i) out.push("");
        out[i] = value;
      }
      while (out.length && out.at(-1) === "") out.pop();
      rows.push(out);
    }
    return rows;
  } catch {
    throw new FundFileError(UNREADABLE);
  }
}
