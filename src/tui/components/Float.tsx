import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { borderTop } from "../text";
import { color } from "../theme";
import { Row, type Segment } from "./Row";

type Props = { title: string; rows: Segment[][]; width: number; top: number; left: number; footer?: ReactNode };

// A bordered box drawn over the panes. Every inner cell is written, padded with spaces, so nothing beneath shows through.
export function Float({ title, rows, width, top, left }: Props) {
  const inner = width - 2;
  return (
    <Box position="absolute" top={top} left={left} flexDirection="column" width={width}>
      <Text color={color.accent} bold>
        {borderTop(title, width)}
      </Text>
      {rows.map((segments, i) => (
        <Text key={i}>
          <Text color={color.accent}>│</Text>
          <Row segments={segments} cols={inner} />
          <Text color={color.accent}>│</Text>
        </Text>
      ))}
      <Text color={color.accent}>{`╰${"─".repeat(inner)}╯`}</Text>
    </Box>
  );
}
