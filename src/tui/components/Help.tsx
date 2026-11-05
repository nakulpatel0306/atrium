import { HELP } from "../keys";
import { truncate, width as textWidth } from "../text";
import { color } from "../theme";
import { Float } from "./Float";
import type { Segment } from "./Row";

const KEYS_COL = 15;
// Balanced so neither column runs much longer than the other.
const SECTIONS = [["Move", "Space"], ["Act", "Views"]] as const;

// Every key, grouped by what it does, in two columns.
export function Help({ cols, rows }: { cols: number; rows: number }) {
  const width = Math.min(100, cols - 4);
  const half = Math.floor((width - 2) / 2);
  const column = (sections: readonly string[]): Segment[][] =>
    sections.flatMap((section, i) => [
      ...(i > 0 ? [[]] : []),
      [{ text: section, bold: true, color: color.accent }],
      ...HELP.filter((h) => h.section === section).map((h) => [
        { text: h.keys.padEnd(KEYS_COL), color: color.info },
        { text: truncate(h.does, half - KEYS_COL - 2) },
      ]),
    ]);
  const [left, right] = SECTIONS.map(column) as [Segment[][], Segment[][]];
  const lines: Segment[][] = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [
    ...padTo(left[i] ?? [], half),
    ...(right[i] ?? []),
  ]);
  const top = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
  return <Float title="Help · ? or q to close" rows={lines} width={width} top={top} left={Math.floor((cols - width) / 2)} />;
}

function padTo(segments: Segment[], cols: number): Segment[] {
  const used = segments.reduce((n, s) => n + textWidth(s.text), 0);
  return [...segments, { text: " ".repeat(Math.max(1, cols - used)) }];
}
