import { Text } from "ink";
import { truncate, width } from "../text";
import type { AnsiColor } from "../theme";

export type Segment = { text: string; color?: AnsiColor; bold?: boolean; dim?: boolean };

// Fits colored pieces into exactly `cols` columns, cutting the last one that overflows with an ellipsis.
export function fit(segments: Segment[], cols: number): Segment[] {
  const out: Segment[] = [];
  let used = 0;
  for (const s of segments) {
    if (used >= cols) break;
    const room = cols - used;
    const text = width(s.text) > room ? truncate(s.text, room) : s.text;
    out.push({ ...s, text });
    used += width(text);
  }
  if (used < cols) out.push({ text: " ".repeat(cols - used) });
  return out;
}

// One list row. The selected row is inverted in the focused pane (the terminal's own colors, never a set
// background) and bold elsewhere, so each pane still shows what it points at.
export function Row({ segments, cols, selected }: { segments: Segment[]; cols: number; selected?: "focused" | "idle" }) {
  const inverse = selected === "focused";
  return (
    <Text inverse={inverse} bold={selected === "idle"} wrap="truncate">
      {fit(segments, cols).map((s, i) => (
        <Text key={i} color={inverse ? undefined : s.color} bold={s.bold} dimColor={s.dim}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <Text color="gray" wrap="wrap">
      {text}
    </Text>
  );
}
