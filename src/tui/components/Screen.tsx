import { Box, Text } from "ink";
import type { Line, Seg } from "../canvas";
import { ON_FILL, type Palette, theme } from "../theme";

// A segment's Ink props under the palette. A chip whose fill the palette can't paint is inverse instead (bold for
// the selected tab), and a key cap is bold accent text, so chips still read in 16 colors and under NO_COLOR.
export function paint(s: Seg, p: Palette) {
  let color = s.color ? p.fg[s.color] : undefined;
  let backgroundColor: string | undefined;
  let inverse = s.inverse ?? false;
  let bold = s.bold ?? false;
  if (s.bg) {
    const fill = p.bg[s.bg];
    if (fill) {
      backgroundColor = fill;
      color = ON_FILL[s.bg] ?? color;
    } else if (s.bg === "key") {
      color = p.fg.accent;
      bold = true;
    } else {
      inverse = !inverse;
      bold ||= s.bg === "accent";
    }
  }
  if (p.contrast && s.color === "accent") bold = true;
  return { color, backgroundColor, inverse, bold, italic: s.italic ?? false, dimColor: s.dim ?? false };
}

const ASCII = /─{4,}|[\x20-\x7e]+|[^\x20-\x7e─]+|─+/g;
const RULE = /^─{4,}$/;

// Ink measures every text node on every frame, and its width function is slow for anything past plain ASCII (each
// character goes through an emoji check). Box edges and glyphs are on every line, so each line is split into runs:
// long plain-ASCII runs take Ink's fast path, long rules are drawn as a border (which Ink doesn't measure), and the
// rest are a few characters each.
export function runs(line: Line): Seg[] {
  return line.flatMap((s) => (s.text.match(ASCII) ?? []).map((text) => ({ ...s, text })));
}

// Prints composed lines, one Ink row each. The lines are already exactly the window's width.
export function Screen({ lines }: { lines: Line[] }) {
  const p = theme();
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line, i) => (
        <Box key={i} flexDirection="row" height={1} flexShrink={0}>
          {runs(line).map((s, j) =>
            RULE.test(s.text) ? (
              <Box key={j} width={s.text.length} height={1} flexShrink={0} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor={paint(s, p).color} />
            ) : (
              <Text key={j} wrap="truncate" {...paint(s, p)}>
                {s.text}
              </Text>
            ),
          )}
        </Box>
      ))}
    </Box>
  );
}
