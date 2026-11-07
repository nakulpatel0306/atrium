// Activity: the Plan 13 feed, day by day, one folded line per stretch of work, with the picked line's full lines
// beside it (below it under 100 columns).
import { actorName } from "../../dashboard/summary";
import { type ActivityTone, byDay, leadOf } from "../../engine/activity-groups";
import { type Block, columns, fit, type Hit, label, type Line, rowsOf } from "../canvas";
import { activityDetail, groupWhen, TONE_COLOR, wrapStyled } from "../detail";
import { pick, type View } from "../select";
import type { Ui } from "../ui";

// Never color alone: each tone has its own mark.
const MARK: Record<ActivityTone, string> = { routine: "·", attention: "!", failure: "✗", notice: "✓" };

export const activityDetailRows = (rows: number, cols: number) => (cols >= 100 ? rows - 1 : rows - Math.floor(rows * 0.55) - 2);
export const activityDetailWidth = (cols: number) => (cols >= 100 ? cols - Math.min(72, Math.floor(cols * 0.58)) - 4 : cols - 3);

export function activityLines(view: View, cols: number): Line[] {
  return activityDetail(view).flatMap((l) => wrapStyled(l, activityDetailWidth(cols)));
}

export function activityScreen(view: View, ui: Ui, cols: number, rows: number, y0: number, now: number): Block {
  const names = new Map([...view.state.spaces, ...(view.state.archived ?? [])].map((s) => [s.id, s.name]));
  const wide = cols >= 100;
  const listW = wide ? Math.min(72, Math.floor(cols * 0.58)) : cols;
  const listRows = wide ? rows : Math.floor(rows * 0.55);
  const { item: picked } = pick(view.activity, ui.selected.activity);
  const pinnedId = ui.selected.activity.id;
  const lines: { line: Line; id: string | null }[] = [];
  for (const day of byDay(view.activity)) {
    lines.push({ line: [{ text: " " }, label(day.day)], id: null });
    for (const g of day.groups) {
      const sel = g.id === pinnedId && picked?.id === g.id;
      const space = g.spaceId ? names.get(g.spaceId) : undefined;
      const lead = leadOf(g) ?? (g.title ? null : actorName(g.actor));
      const fill = sel ? { bg: "soft" as const } : {};
      const tone = TONE_COLOR[g.tone];
      lines.push({
        id: g.id,
        line: fit(
          [
            { text: sel ? "▌" : " ", color: "accent" },
            { text: ` ${groupWhen(g, now).padEnd(6)}`, color: "faint", ...fill },
            { text: `${MARK[g.tone]} `, color: tone ?? "faint", ...fill },
            ...(lead ? [{ text: lead, color: "info" as const, ...fill }, { text: " · ", ...fill }] : []),
            { text: g.text, color: tone, bold: sel, ...fill },
            ...(g.count > 1 ? [{ text: ` ×${g.count}`, color: "faint" as const, ...fill }] : []),
            ...(space ? [{ text: ` · ${space}`, color: "faint" as const, ...fill }] : []),
          ],
          listW,
          fill,
        ),
      });
    }
  }
  const filter = ui.filters.activity ? [{ text: `  /${ui.filters.activity}`, color: "info" as const }] : [];
  const head: Line = [{ text: " " }, { ...label("Activity"), color: "accent" }, ...filter];
  const room = listRows - 1;
  const at = lines.findIndex((l) => l.id !== null && l.id === picked?.id);
  const first = Math.max(0, Math.min(at - Math.floor(room / 2), lines.length - room));
  const shown = lines.slice(first, first + room);
  const hits: Hit[] = shown.flatMap((l, i) => (l.id ? [{ x: 0, y: y0 + 1 + i, w: listW, h: 1, click: { select: { pane: "activity" as const, id: l.id } }, wheel: "list" as const }] : []));
  const list: Line[] = [head, ...(lines.length ? shown.map((l) => l.line) : [[{ text: "  No activity yet. Agent runs and your decisions will show up here.", color: "faint" as const }]])];
  const detail = activityLines(view, cols);
  const dRows = activityDetailRows(rows, cols);
  const top = Math.min(ui.activityScroll, Math.max(0, detail.length - dRows));
  const more = detail.length > top + dRows ? `  ↓ ${detail.length - top - dRows} more · ctrl-d` : "";
  const detailBlock: Line[] = [[{ text: " " }, label("Lines"), { text: more, color: "faint" }], ...detail.slice(top, top + dRows).map((l) => [{ text: " " }, ...l])];
  if (wide) {
    const divider = Array.from({ length: rows }, (): Line => [{ text: "│", color: "line" }]);
    return { lines: columns([{ lines: list, w: listW }, { lines: divider, w: 1 }, { lines: detailBlock.map((l) => [{ text: " " }, ...l]), w: cols - listW - 1 }], rows), hits };
  }
  return { lines: rowsOf([...rowsOf(list, cols, listRows), [{ text: "─".repeat(cols), color: "line" }], ...detailBlock], cols, rows), hits };
}
