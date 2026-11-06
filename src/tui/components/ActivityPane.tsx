import { leadOf } from "../../engine/activity-groups";
import { actorName } from "../../dashboard/summary";
import { groupWhen, TONE_COLOR } from "../detail";
import { color } from "../theme";
import { List, type ListProps, pad } from "./List";

// One row per group: today's rows say how long ago, older ones their day, so the days read in order.
export function ActivityPane(p: ListProps) {
  const names = new Map([...p.view.state.spaces, ...(p.view.state.archived ?? [])].map((s) => [s.id, s.name]));
  return (
    <List
      {...p}
      items={p.view.activity}
      pane="activity"
      empty="No activity yet. Agent runs and your decisions will show up here."
      render={(g) => {
        const space = g.spaceId ? names.get(g.spaceId) : undefined;
        const lead = leadOf(g) ?? (g.title ? null : actorName(g.actor));
        // What happened comes first, so a narrow pane still shows it; the space name trails.
        return [
          { text: `${pad(groupWhen(g), 6)} `, color: color.muted },
          ...(lead ? [{ text: lead, color: color.info }, { text: " · " }] : []),
          { text: g.text, color: TONE_COLOR[g.tone] },
          ...(space ? [{ text: ` · ${space}`, color: color.muted }] : []),
        ];
      }}
    />
  );
}
