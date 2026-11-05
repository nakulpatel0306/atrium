// A one-line text input, as a pure function of the line and one key event. Ink has no input component.
import type { Key } from "ink";
import { clean } from "./text";

export type Line = { value: string; cursor: number };

const segmenter = new Intl.Segmenter();

// Cursor stops between graphemes, so backspace removes a whole emoji rather than half of one.
function stops(value: string): number[] {
  return [...Array.from(segmenter.segment(value), (g) => g.index), value.length];
}
const before = (value: string, cursor: number) => stops(value).filter((i) => i < cursor).at(-1) ?? 0;
const after = (value: string, cursor: number) => stops(value).find((i) => i > cursor) ?? value.length;

export function editLine(line: Line, input: string, key: Key): Line | "submit" | "cancel" {
  const { value, cursor } = line;
  if (key.return) return "submit";
  if (key.escape) return "cancel";
  if (key.ctrl) {
    if (input === "a") return { value, cursor: 0 };
    if (input === "e") return { value, cursor: value.length };
    if (input === "u") return { value: "", cursor: 0 };
    return line;
  }
  if (key.backspace) {
    const at = before(value, cursor);
    return { value: value.slice(0, at) + value.slice(cursor), cursor: at };
  }
  if (key.delete) return { value: value.slice(0, cursor) + value.slice(after(value, cursor)), cursor };
  if (key.leftArrow) return { value, cursor: before(value, cursor) };
  if (key.rightArrow) return { value, cursor: after(value, cursor) };
  if (key.meta || key.tab || key.upArrow || key.downArrow) return line;
  // Pasted text can carry newlines and escapes; the prompt is one line of plain text.
  const text = clean(input).replace(/\n+/g, " ");
  if (!text) return line;
  return { value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length };
}

// The prompt's text split around the cursor; the cursor cell is a whole grapheme, or a space at the end.
export function cursorParts(line: Line): { before: string; at: string; after: string } {
  const end = after(line.value, line.cursor);
  return {
    before: line.value.slice(0, line.cursor),
    at: line.cursor < line.value.length ? line.value.slice(line.cursor, end) : " ",
    after: line.value.slice(end),
  };
}
