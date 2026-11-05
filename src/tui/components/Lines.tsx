import { Box, Text } from "ink";
import type { DetailLine } from "../detail";

// Pre-wrapped styled lines, one Ink row each.
export function Lines({ lines }: { lines: DetailLine[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line.length === 0
            ? " "
            : line.map((s, j) => (
                <Text key={j} color={s.color} bold={s.bold} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
