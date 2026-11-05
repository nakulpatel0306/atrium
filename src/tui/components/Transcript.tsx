import { Box, Text } from "ink";
import { Pane } from "./Pane";

type Props = { title: string; lines: string[]; scroll: number; width: number; height: number };

// A run's whole transcript, full screen. `lines` arrive cleaned and wrapped to the pane.
export function Transcript({ title, lines, scroll, width, height }: Props) {
  const rows = height - 2;
  const top = Math.min(scroll, Math.max(0, lines.length - rows));
  return (
    <Pane n={0} title={title} focused width={width} height={height} padded>
      <Box flexDirection="column">
        {lines.slice(top, top + rows).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l || " "}
          </Text>
        ))}
      </Box>
    </Pane>
  );
}
