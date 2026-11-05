import { truncate, width } from "../text";
import { color, spaceColor } from "../theme";
import { List, type ListProps, pad } from "./List";

export function NeedsPane(p: ListProps) {
  const names = new Map(p.view.state.spaces.map((s, i) => [s.id, { name: s.name, i }]));
  const nameWidth = Math.min(12, Math.max(0, ...p.view.approvals.map((a) => width(names.get(a.spaceId)?.name ?? ""))));
  return (
    <List
      {...p}
      items={p.view.approvals}
      pane="needs"
      empty="You're all caught up."
      render={(a) => {
        const space = names.get(a.spaceId);
        return [
          { text: `${pad(truncate(space?.name ?? "Unknown space", nameWidth), nameWidth)}  `, color: space ? spaceColor(space.i) : color.muted },
          { text: a.title },
        ];
      }}
    />
  );
}

