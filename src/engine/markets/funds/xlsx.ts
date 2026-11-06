import { strFromU8, Unzip, UnzipInflate } from "fflate";
import { FundFileError } from "./types";

const UNREADABLE = "That holdings file isn't a spreadsheet Atrium can read.";
const TOO_LARGE = "That holdings file is too large to be a holdings spreadsheet.";
// A real SPY sheet inflates to well under 1 MB; anything near this is a zip bomb.
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

// Fed to the unzipper a little at a time: deflate can grow 1 KB into about 1 MB, so small input chunks keep the
// running cap below from being overshot by much before it's checked.
const PUSH_BYTES = 4096;

// Only the parts Atrium reads are inflated. A part's declared size is checked first, but the header can lie, so the
// output is also counted as it inflates and cut off at the cap.
function unzipParts(bytes: Uint8Array, wanted: Set<string>): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let tooLarge = false;
  let broken = false;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (!wanted.has(file.name)) return;
    if ((file.originalSize ?? 0) >= MAX_PART_BYTES) {
      tooLarge = true;
      return;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    file.ondata = (err, chunk, final) => {
      if (err) {
        broken = true;
        return;
      }
      total += chunk.length;
      if (total >= MAX_PART_BYTES) {
        tooLarge = true;
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        files[file.name] = out;
      }
    };
    file.start();
  };
  try {
    for (let at = 0; at < bytes.length && !tooLarge && !broken; at += PUSH_BYTES) {
      unzip.push(bytes.subarray(at, at + PUSH_BYTES), at + PUSH_BYTES >= bytes.length);
    }
  } catch {
    broken = true;
  }
  if (tooLarge) throw new FundFileError(TOO_LARGE);
  if (broken) throw new FundFileError(UNREADABLE);
  return files;
}

// One sheet of an .xlsx as a grid of strings: shared, inline and numeric cells, blanks kept in place. Enough for
// one issuer file; anything fancier isn't needed.
export function readXlsxRows(bytes: Uint8Array, sheet = 0): string[][] {
  const files = unzipParts(bytes, new Set(["xl/sharedStrings.xml", `xl/worksheets/sheet${sheet + 1}.xml`]));
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
