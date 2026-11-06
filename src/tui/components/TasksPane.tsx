import { needsAction, waitOf } from "../../dashboard/agents";
import { shownTitle, STATUS_TEXT } from "../../dashboard/summary";
import { truncate, width } from "../text";
import { color, GLYPH, STATUS_GLYPH } from "../theme";
import { outcomeLabel } from "../../engine/outcome";
import { List, type ListProps, pad } from "./List";

export function TasksPane(p: ListProps) {
  const { state, space } = p.view;
  return (
    <List
      {...p}
      items={p.view.tasks}
      pane="tasks"
      empty={space ? `No tasks yet. Press n to give ${space.name} one.` : "Pick a space in [1] to see its tasks."}
      render={(task) => {
        const notDone = task.status === "done" && task.outcome ? outcomeLabel(task.outcome) : null;
        // A finished task the agent said it couldn't or only partly do never wears the done check.
        const glyph = notDone ? { glyph: GLYPH.notdone, color: color.warn } : STATUS_GLYPH[task.status];
        const wait = waitOf(task, state);
        const label = wait ? "waiting" : (notDone ?? STATUS_TEXT[task.status]);
        const tone = wait ? (needsAction(wait) ? color.bad : color.warn) : notDone ? color.warn : task.status === "blocked" || task.status === "failed" ? color.bad : color.muted;
        const kind = task.kind === "work" ? "" : `${task.kind} · `;
        const titleRoom = Math.max(1, p.cols - 2 - width(label) - 1);
        return [
          { text: `${glyph.glyph} `, color: glyph.color },
          { text: kind, color: color.info },
          { text: pad(truncate(shownTitle(task), titleRoom - width(kind)), titleRoom - width(kind)) },
          { text: ` ${label}`, color: tone },
        ];
      }}
    />
  );
}

