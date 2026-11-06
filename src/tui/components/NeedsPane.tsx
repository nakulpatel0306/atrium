import { truncate, width } from "../text";
import { type AnsiColor, color, GLYPH, spaceColor } from "../theme";
import { List, type ListProps, pad } from "./List";

type Approval = ListProps["view"]["approvals"][number];

// A text reads as who and what; a result the agent said it didn't finish leads with the warning mark.
function approvalRow(a: Approval, state: ListProps["view"]["state"]): { text: string; color?: AnsiColor }[] {
  const text = a.alwaysAsk === "send_message" ? state.messageActions.find((m) => m.approvalId === a.id) : undefined;
  if (text) return [{ text: `Text ${text.toName}: ${text.text.split("\n")[0]}` }];
  const outcome = a.kind === "review" && a.taskId ? state.tasks.find((t) => t.id === a.taskId)?.outcome : null;
  if (outcome === "couldnt" || outcome === "partial") return [{ text: `${GLYPH.notdone} `, color: color.warn }, { text: a.title }];
  return [{ text: a.title }];
}

export function NeedsPane(p: ListProps) {
  const names = new Map(p.view.state.spaces.map((s, i) => [s.id, { name: s.name, i }]));
  const items = [...p.view.proposals, ...p.view.approvals];
  // A question with no space (a new repo, removing a local copy) is Atrium's own.
  const nameOf = (spaceId: string | null) => (spaceId ? names.get(spaceId) : { name: "Atrium", i: -1 });
  const nameWidth = Math.min(12, Math.max(0, ...items.map((a) => width(nameOf(a.spaceId)?.name ?? ""))));
  return (
    <List
      {...p}
      items={items}
      pane="needs"
      empty="You're all caught up."
      render={(a) => {
        const space = nameOf(a.spaceId);
        return [
          {
            text: `${pad(truncate(space?.name ?? "Unknown space", nameWidth), nameWidth)}  `,
            color: !space ? color.muted : space.i < 0 ? color.info : spaceColor(space.i),
          },
          ...("label" in a ? [{ text: `${GLYPH.suggestion} `, color: color.info }, { text: `Stop asking about ${a.label}?` }] : approvalRow(a, p.view.state)),
        ];
      }}
    />
  );
}

