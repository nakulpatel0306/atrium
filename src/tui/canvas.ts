// Screens are built as lines of styled segments, exactly as wide as the window, the way the approved mockup was
// composed. Boxes then line up by construction, overlays are spliced in by column, and the clickable regions are the
// same numbers the drawing used.
import { oneLine, truncate, width } from "./text";
import type { Fill, Tone } from "./theme";

export type Seg = { text: string; color?: Tone; bg?: Fill; bold?: boolean; italic?: boolean; inverse?: boolean; dim?: boolean };
export type Line = Seg[];

// What a click on a region does: switch tab, select a row (and focus its pane), and/or act as if a key was pressed.
// `strip` marks a key cap on the bottom strip: while the Ask box is open those are its own keys (enter, esc, tab),
// so a click there goes to the box; every other click closes the box first.
export type Click = { strip?: true; tab?: number; select?: { pane: "spaces" | "tasks" | "needs" | "activity"; id: string }; focus?: "spaces" | "tasks" | "detail" | "live"; input?: string; ask?: true; row?: { index: number } };
export type Hit = { x: number; y: number; w: number; h: number; click: Click; wheel?: "list" | "detail" | "live" };
export type Block = { lines: Line[]; hits: Hit[] };

export const lineWidth = (l: Line) => l.reduce((n, s) => n + width(s.text), 0);
export const plainText = (l: Line) => l.map((s) => s.text).join("");

// Fits a line into exactly `cols` columns: the piece that overflows is cut with an ellipsis, a short line is padded
// with spaces carrying `fill` (so a selected row's background reaches the edge).
export function fit(line: Line, cols: number, fill?: Partial<Seg>): Line {
  const out: Line = [];
  let used = 0;
  for (const s of line) {
    if (used >= cols) break;
    const room = cols - used;
    // Defense in depth: the client already scrubs engine text, but a row must never carry a control byte.
    const plain = oneLine(s.text);
    const text = width(plain) > room ? truncate(plain, room) : plain;
    if (!text) continue;
    out.push({ ...s, text });
    used += width(text);
  }
  if (used < cols) out.push({ ...fill, text: " ".repeat(cols - used) });
  return out;
}

const blank = (cols: number): Line => [{ text: " ".repeat(cols) }];

// Pads a block of lines to `rows`, cutting any past it.
export function rowsOf(lines: Line[], cols: number, rows: number): Line[] {
  const out = lines.slice(0, rows).map((l) => fit(l, cols));
  while (out.length < rows) out.push(blank(cols));
  return out;
}

const seg = (text: string, color?: Tone): Seg => ({ text, color });

// A rounded box with a title in its top edge. `tone` colors the edge; the selected card's edge is the accent.
export function box(title: Line, body: Line[], cols: number, rows: number, tone: Tone = "line", bold = false): Line[] {
  const inner = cols - 2;
  const t: Line = title.length ? [seg(" ", tone), ...fit(title, Math.min(lineWidth(title), Math.max(0, inner - 4))), seg(" ", tone)] : [];
  const edge = { color: tone, bold };
  const top: Line = [{ ...edge, text: "╭─" }, ...t, { ...edge, text: `${"─".repeat(Math.max(0, inner - 1 - lineWidth(t)))}╮` }];
  const rows_: Line[] = body.slice(0, Math.max(0, rows - 2)).map((b) => [{ ...edge, text: "│" }, ...fit([{ text: " " }, ...b], inner), { ...edge, text: "│" }]);
  while (rows_.length < rows - 2) rows_.push([{ ...edge, text: "│" }, { text: " ".repeat(inner) }, { ...edge, text: "│" }]);
  const bottom: Line = [{ ...edge, text: `╰${"─".repeat(inner)}╯` }];
  return [top, ...rows_, bottom];
}

// The bottom edge with text in it, for the Ask box's "what just happened" line.
export function edgeWith(label: Line, cols: number, tone: Tone = "line"): Line {
  const inner = cols - 2;
  const shown = label.length ? [seg(" "), ...fit(label, Math.min(lineWidth(label), Math.max(0, inner - 4))), seg(" ")] : [];
  return [seg("╰─", tone), ...shown, seg(`${"─".repeat(Math.max(0, inner - 1 - lineWidth(shown)))}╯`, tone)];
}

// Columns side by side, each padded to its width, with `gap` spaces between.
export function columns(cols: { lines: Line[]; w: number }[], rows: number, gap = 0): Line[] {
  return Array.from({ length: rows }, (_, i) =>
    cols.flatMap((c, j) => [...fit(c.lines[i] ?? [], c.w), ...(j < cols.length - 1 && gap ? [seg(" ".repeat(gap))] : [])]),
  );
}

// Moves every hit right and down, for a block drawn inside a bigger one.
export const shift = (hits: Hit[], dx: number, dy: number): Hit[] => hits.map((h) => ({ ...h, x: h.x + dx, y: h.y + dy }));

const segmenter = new Intl.Segmenter();

// The columns [from, to) of a line. A wide character cut in half becomes a space, so nothing shifts.
export function slice(line: Line, from: number, to: number): Line {
  const out: Line = [];
  let col = 0;
  for (const s of line) {
    let text = "";
    for (const { segment } of segmenter.segment(s.text)) {
      const w = width(segment);
      if (col >= from && col + w <= to) text += segment;
      else if (col < to && col + w > from) text += " ".repeat(Math.min(col + w, to) - Math.max(col, from));
      col += w;
    }
    if (text) out.push({ ...s, text });
    if (col >= to) break;
  }
  return out;
}

// Draws `top` over `base` at column x, row y. The covered cells are replaced; the rest of each row stays.
export function splice(base: Line[], top: Line[], x: number, y: number): Line[] {
  const out = [...base];
  top.forEach((t, i) => {
    const row = y + i;
    if (row < 0 || row >= out.length) return;
    const b = out[row]!;
    const total = lineWidth(b);
    const w = lineWidth(t);
    out[row] = [...slice(b, 0, x), ...t, ...slice(b, x + w, total)];
  });
  return out;
}

// A key cap: the key on a chip, then what it does. `hot` is the card's main action.
export const keycap = (key: string, label: string, hot = false): Line => [
  { text: ` ${key} `, bg: hot ? "accent" : "key", bold: true },
  { text: ` ${label}`, color: "dim" },
];

// A row of key caps with two spaces between, and the regions that press each key.
export function keyRow(keys: { key: string; label: string; input: string; hot?: boolean }[], x: number, y: number): { line: Line; hits: Hit[] } {
  const line: Line = [];
  const hits: Hit[] = [];
  let col = x;
  keys.forEach((k, i) => {
    if (i > 0) {
      line.push({ text: "  " });
      col += 2;
    }
    const cap = keycap(k.key, k.label, k.hot);
    const w = lineWidth(cap);
    hits.push({ x: col, y, w, h: 1, click: { input: k.input } });
    line.push(...cap);
    col += w;
  });
  return { line, hits };
}

// A horizontal bar of `cells` cells: filled for `frac`, the rest empty.
export function bar(frac: number, cells: number, tone: Tone): Line {
  const full = Math.max(0, Math.min(cells, Math.round(frac * cells)));
  return [
    { text: "█".repeat(full), color: tone },
    { text: "░".repeat(cells - full), color: "line" },
  ];
}

export const label = (text: string): Seg => ({ text: text.toUpperCase(), color: "faint", bold: true });

// A rule across `cols` with a label in it: "─ LIVE · Claude ──────".
export function rule(label: Line, cols: number, tone: Tone = "line"): Line {
  const head: Line = [{ text: "─ ", color: tone }, ...label, { text: " " }];
  const room = cols - lineWidth(head);
  return room > 0 ? [...head, { text: "─".repeat(room), color: tone }] : fit(head, cols);
}
