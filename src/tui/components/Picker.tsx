import { agentName } from "../../dashboard/agents";
import type { State } from "../../engine/state";
import { color } from "../theme";
import type { Overlay } from "../ui";
import { Float } from "./Float";
import type { Segment } from "./Row";

type PickerOverlay = Extract<Overlay, { kind: "picker" }>;

const WIDTH = 44;

type Props = { picker: PickerOverlay; state: State; reviewers: Record<string, string | null> | null; cols: number; rows: number };

// A small list in the middle of the screen: j/k to move, enter to pick, esc to leave it as it was.
export function Picker({ picker, state, reviewers, cols, rows }: Props) {
  const title =
    picker.purpose === "agent"
      ? `Agent for ${state.tasks.find((t) => t.id === picker.targetId)?.title ?? "this task"}`
      : `Reviewer for ${state.spaces.find((s) => s.id === picker.targetId)?.name ?? "this space"}`;
  const lines: Segment[][] = picker.options.map((id, i) => {
    const label = id === "none" ? "No one" : agentName(id);
    const why = picker.purpose === "reviewer" && reviewers?.[id] ? " (can't work here)" : "";
    const mark = i === picker.index;
    return [
      { text: mark ? "› " : "  ", color: color.accent },
      { text: label, bold: mark },
      { text: why, color: color.bad },
    ];
  });
  lines.push([], [{ text: "j k move · enter pick · esc cancel", color: color.muted }]);
  const width = Math.min(WIDTH, cols - 4);
  const top = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
  return <Float title={title} rows={lines} width={width} top={top} left={Math.floor((cols - width) / 2)} />;
}
