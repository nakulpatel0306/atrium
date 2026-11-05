import { Text } from "ink";
import { liveStatus } from "../../dashboard/summary";
import type { State } from "../../engine/state";
import { truncate } from "../text";
import { color } from "../theme";

// The briefing is the one from when the app opened, as on the dashboard; the live tail is recomputed.
export function Header({ state, briefing, cols }: { state: State; briefing: State["briefing"]; cols: number }) {
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const lead = ` Atrium · ${date} · `;
  const rest = truncate(`${briefing.greeting} ${briefing.summary}${liveStatus(state)}`, Math.max(0, cols - lead.length));
  return (
    <Text wrap="truncate">
      <Text color={color.accent} bold>
        {lead}
      </Text>
      {rest}
    </Text>
  );
}
