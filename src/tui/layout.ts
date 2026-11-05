// Pane sizes for a window, lazygit-style: the active left pane opens up and the others stay visible as strips.
import type { ListPane, Pane } from "./ui";

export type Layout = { left: number; right: number; heights: Record<ListPane, number>; detail: number; live: number };

export const MIN_COLS = 80;
export const MIN_ROWS = 24;
const LEFT_PANES: ListPane[] = ["spaces", "tasks", "needs", "activity"];
// One header row above the panes and one status row below.
const CHROME_ROWS = 2;

export function layout(cols: number, rows: number, focus: Pane, lastLeft: ListPane): Layout | { tooSmall: true } {
  if (cols < MIN_COLS || rows < MIN_ROWS) return { tooSmall: true };
  const body = rows - CHROME_ROWS;
  const left = Math.min(60, Math.max(32, Math.floor(cols * 0.38)));
  const active = focus === "detail" || focus === "live" ? lastLeft : focus;
  const big = Math.max(3, Math.floor(body * 0.4));
  const others = LEFT_PANES.filter((p) => p !== active);
  const share = Math.floor((body - big) / others.length);
  let extra = body - big - share * others.length;
  const heights = { [active]: big } as Record<ListPane, number>;
  for (const p of others) heights[p] = share + (extra-- > 0 ? 1 : 0);
  const detail = Math.floor(body * 0.55);
  return { left, right: cols - left, heights, detail, live: body - detail };
}
