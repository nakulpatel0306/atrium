import { spaceStatus } from "../../dashboard/summary";
import { width } from "../text";
import { type AnsiColor, color, spaceColor } from "../theme";
import { List, type ListProps, pad } from "./List";

const TONE: Record<string, AnsiColor> = { blocked: color.bad, waiting: color.warn };

export function SpacesPane(p: ListProps) {
  const { state } = p.view;
  const nameWidth = Math.min(14, Math.max(0, ...p.view.spaces.map((s) => width(s.name))));
  return (
    <List
      {...p}
      items={p.view.spaces}
      pane="spaces"
      empty="No spaces yet. Press N to describe one."
      render={(space) => {
        const status = spaceStatus(space, state.tasks.filter((t) => t.spaceId === space.id), state);
        return [
          { text: "● ", color: spaceColor(state.spaces.indexOf(space)) },
          { text: `${pad(space.name, nameWidth)} ` },
          { text: status.text, color: status.tone ? TONE[status.tone] : color.muted },
        ];
      }}
    />
  );
}

