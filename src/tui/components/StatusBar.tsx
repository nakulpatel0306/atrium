import { Box, Text } from "ink";
import type { State } from "../../engine/state";
import { oneLine, truncate, width } from "../text";
import { color, windowGauge } from "../theme";
import type { Flash } from "../ui";

const FLASH_TONE = { ok: color.ok, bad: color.bad, info: color.info } as const;
const GAUGE_COLS = 28;

type Props = { state: State; cols: number; hints: string; flash: Flash | null; online: boolean };

// Left: what just happened, or what the focused pane's keys do. Right: Claude's window, power, overnight.
export function StatusBar({ state, cols, hints, flash, online }: Props) {
  const gauge = windowGauge(state, GAUGE_COLS);
  const tail = [
    state.power.source === "ac" ? "AC" : "battery",
    ...(state.power.overnight ? ["overnight"] : []),
  ].join(" · ");
  const offline = online ? "" : "offline · reconnecting · ";
  const right = `${offline}${gauge.text} · ${tail} `;
  const leftCols = Math.max(0, cols - width(right) - 1);
  const left = truncate(oneLine(` ${flash ? flash.text : hints}`), leftCols);
  return (
    <Box width={cols}>
      <Box width={leftCols + 1}>
        <Text color={flash ? FLASH_TONE[flash.tone] : color.muted} wrap="truncate">
          {left}
        </Text>
      </Box>
      <Text wrap="truncate">
        {offline && <Text color={color.bad}>{offline}</Text>}
        <Text color={gauge.tone === "warn" ? color.warn : color.muted}>{gauge.text}</Text>
        <Text color={color.muted}>{` · ${tail} `}</Text>
      </Text>
    </Box>
  );
}
