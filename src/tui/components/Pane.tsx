import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { borderTop } from "../text";
import { color } from "../theme";

type Props = { n: number; title: string; focused: boolean; width: number; height: number; padded?: boolean; children?: ReactNode };

// A rounded box with its number and title drawn into the top edge, as lazygit does.
export function Pane({ n, title, focused, width, height, padded, children }: Props) {
  const tone = focused ? color.accent : color.muted;
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Text color={tone} bold={focused}>
        {borderTop(`[${n}] ${title}`, width)}
      </Text>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderColor={tone}
        width={width}
        height={height - 1}
        overflow="hidden"
        paddingX={padded ? 1 : 0}
      >
        {children}
      </Box>
    </Box>
  );
}
