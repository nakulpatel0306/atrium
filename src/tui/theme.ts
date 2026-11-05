// Every color the terminal app uses. Only the 16 ANSI names, so the user's terminal theme decides the actual hues.
import type { State } from "../engine/state";
import type { TaskStatus } from "../engine/tasks";
import { truncate } from "./text";

type Base = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";
export type AnsiColor = Base | `${Base}Bright` | "gray";

export const color = {
  accent: "blue",
  ok: "green",
  warn: "yellow",
  bad: "red",
  muted: "gray",
  info: "cyan",
} as const satisfies Record<string, AnsiColor>;

export const STATUS_GLYPH: Record<TaskStatus, { glyph: string; color: AnsiColor }> = {
  running: { glyph: "●", color: "green" },
  queued: { glyph: "○", color: "gray" },
  review: { glyph: "◆", color: "blue" },
  done: { glyph: "✓", color: "gray" },
  failed: { glyph: "✗", color: "red" },
  blocked: { glyph: "!", color: "red" },
};

// Single-width symbols only; emoji widths vary between terminals and break the borders.
export const GLYPH = {
  dot: "●",
  arrow: "→",
  pointer: "›",
  bar: "█",
  barEmpty: "░",
  barMark: "│",
  barLeft: "▕",
  barRight: "▏",
  ellipsis: "…",
  suggestion: "✦",
} as const;

const SPACE_COLORS: AnsiColor[] = ["blue", "green", "yellow", "magenta", "cyan", "red"];
// A space's stored color is hex for the dashboard; here the hue comes from its position instead.
export const spaceColor = (index: number): AnsiColor => SPACE_COLORS[index % SPACE_COLORS.length]!;

const GAUGE_LABEL = "Claude 5h";
const MAX_BAR = 20;

// The marker sits where Claude tasks start waiting, so the bar shows how close that is.
export function windowGauge(state: State, cols: number): { text: string; tone: "ok" | "warn" | "muted" } {
  const w = state.claudeWindow;
  if (!w) return { text: truncate(`${GAUGE_LABEL} · no reading yet`, cols), tone: "muted" };
  const used = Math.min(1, Math.max(0, w.utilization));
  const pct = ` ${Math.round(used * 100)}%`;
  // label, space, two bar ends, then the percentage
  const bar = Math.min(MAX_BAR, cols - GAUGE_LABEL.length - 3 - pct.length);
  const tone = used >= w.reserve ? "warn" : "ok";
  if (bar < 3) return { text: truncate(`${GAUGE_LABEL}${pct}`, cols), tone };
  const filled = Math.round(used * bar);
  const mark = Math.min(bar - 1, Math.round(w.reserve * bar));
  const cells = Array.from({ length: bar }, (_, i) =>
    i === mark ? GLYPH.barMark : i < filled ? GLYPH.bar : GLYPH.barEmpty,
  ).join("");
  return { text: `${GAUGE_LABEL} ${GLYPH.barLeft}${cells}${GLYPH.barRight}${pct}`, tone };
}

// Pane borders: the focused one in the accent color, the rest muted; all red while the engine can't be reached,
// so being offline is visible at a glance, not only in the status bar.
export const borderTone = (focused: boolean, online: boolean): AnsiColor =>
  online ? (focused ? color.accent : color.muted) : color.bad;
