import { Box, Text } from "ink";
import { agentText, needsAction } from "../../dashboard/agents";
import { duration } from "../../dashboard/format";
import { distinctWaits, shownTitle } from "../../dashboard/summary";
import type { View } from "../select";
import { tail } from "../text";
import { color } from "../theme";
import { Pane } from "./Pane";

type Props = { view: View; lines: string[]; scroll: number | null; focused: boolean; width: number; height: number };

// The selected space's running agent: its task on the first row, then the tail of its output.
export function LivePane({ view, lines, scroll, focused, width, height }: Props) {
  const live = view.live;
  if (!live) {
    const tasks = view.space ? view.state.tasks.filter((t) => t.spaceId === view.space!.id) : [];
    return (
      <Pane n={5} title="Live" focused={focused} width={width} height={height} padded>
        <Text color={color.muted}>No agent working right now</Text>
        {distinctWaits(tasks, view.state).map((w) => (
          <Text key={w.reason} color={needsAction(w) ? color.bad : color.warn} wrap="truncate">
            {w.reason}
          </Text>
        ))}
      </Pane>
    );
  }
  const { task, run } = live;
  const paused = scroll !== null ? " · paused, G to follow" : "";
  const title = `Live · ${agentText(task, view.state.runs)} · running ${duration(Date.now() - run.startedAt)}${paused}`;
  return (
    <Pane n={5} title={title} focused={focused} width={width} height={height} padded>
      <Text bold wrap="truncate">
        {task.kind === "work" ? "" : `${task.kind} · `}
        {shownTitle(task)}
      </Text>
      {lines.length === 0 ? (
        <Text color={color.muted}>Waiting for the agent's first words…</Text>
      ) : (
        <Box flexDirection="column">
          {tail(lines, height - 3, scroll).map((l, i) => (
            <Text key={i} wrap="truncate">
              {l || " "}
            </Text>
          ))}
        </Box>
      )}
    </Pane>
  );
}
