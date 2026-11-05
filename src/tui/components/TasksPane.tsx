import { needsAction, waitOf } from "../../dashboard/agents";
import { shownTitle, STATUS_TEXT } from "../../dashboard/summary";
import { truncate, width } from "../text";
import { color, STATUS_GLYPH } from "../theme";
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
        const glyph = STATUS_GLYPH[task.status];
        const wait = waitOf(task, state);
        const label = wait ? "waiting" : STATUS_TEXT[task.status];
        const tone = wait ? (needsAction(wait) ? color.bad : color.warn) : task.status === "blocked" || task.status === "failed" ? color.bad : color.muted;
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

