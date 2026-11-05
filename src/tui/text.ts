// Display-width-aware text helpers. Terminal columns, not string length, decide what fits.
const segmenter = new Intl.Segmenter();

// Agent output is untrusted: escape sequences could write the clipboard, retitle the window, or move the cursor.
export function clean(text: string): string {
  return Bun.stripANSI(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

export const width = (s: string) => Bun.stringWidth(s);

const graphemes = (s: string) => Array.from(segmenter.segment(s), (g) => g.segment);

export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  if (max <= 0) return "";
  let out = "";
  let used = 0;
  for (const g of graphemes(s)) {
    const w = width(g);
    if (used + w > max - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

// Hard wrap that never splits a wide character across lines.
export function wrapLines(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let cur = "";
    let used = 0;
    for (const g of graphemes(line)) {
      const w = width(g);
      if (used + w > cols && cur) {
        out.push(cur);
        cur = "";
        used = 0;
      }
      cur += g;
      used += w;
    }
    out.push(cur);
  }
  return out;
}

// The slice of a list to draw so the selected row stays on screen, centred where the list allows.
export function viewport<T>(items: T[], selected: number, height: number): { top: number; rows: T[] } {
  const max = Math.max(0, items.length - height);
  const top = Math.min(max, Math.max(0, selected - Math.floor(height / 2)));
  return { top, rows: items.slice(top, top + height) };
}

// `scroll` null follows the end, like `tail -f`; a number is the first visible line.
export function tail(lines: string[], height: number, scroll: number | null): string[] {
  const max = Math.max(0, lines.length - height);
  const top = scroll === null ? max : Math.min(max, Math.max(0, scroll));
  return lines.slice(top, top + height);
}

// Ink can't put a title in a border, so the top edge is drawn as text.
export function borderTop(label: string, cols: number): string {
  const shown = truncate(label, Math.max(0, cols - 4));
  return `╭─${shown}${"─".repeat(Math.max(0, cols - 3 - width(shown)))}╮`;
}
