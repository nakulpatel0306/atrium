import { relative } from "../../dashboard/format";
import { actorName } from "../../dashboard/summary";
import { color } from "../theme";
import { List, type ListProps, pad } from "./List";

export function ActivityPane(p: ListProps) {
  const names = new Map(p.view.state.spaces.map((s) => [s.id, s.name]));
  return (
    <List
      {...p}
      items={p.view.activity}
      pane="activity"
      empty="No activity yet. Agent runs and your decisions will show up here."
      render={(row) => {
        const when = relative(row.createdAt).replace(" ago", "");
        const space = row.spaceId ? names.get(row.spaceId) : undefined;
        return [
          { text: `${pad(when, 5)} `, color: color.muted },
          { text: `${actorName(row.actor)}${space ? ` · ${space}` : ""}`, color: color.info },
          { text: `: ${row.message}` },
        ];
      }}
    />
  );
}
