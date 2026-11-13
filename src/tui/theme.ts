// Every color the terminal app uses, as tones. Screens name a tone ("accent", "faint"); the palette picked at start
// turns it into Atrium's own hex (truecolor), one of the 16 ANSI names (so the terminal theme decides), or nothing
// (NO_COLOR). The text tone is always the terminal's own foreground, and no background is painted behind the screen.
import type { State } from "../engine/state";
import type { TaskStatus } from "../engine/tasks";
import { truncate } from "./text";

export type Tone = "text" | "dim" | "faint" | "line" | "accent" | "ok" | "warn" | "bad" | "info" | "claude";
// Backgrounds exist only for chips: the selected tab and hot keys (accent), the selected row (soft), key caps (key).
export type Fill = "accent" | "soft" | "key";

export type ColorMode = "truecolor" | "ansi" | "none";
export type Palette = { mode: ColorMode; contrast: boolean; fg: Record<Tone, string | undefined>; bg: Record<Fill, string | undefined> };

// The dashboard's tokens (src/dashboard/styles.css). Lines use --line-strong: --line vanishes on a dark terminal.
const HEX = {
  dim: "#9c9ca6",
  faint: "#868690",
  line: "#34343c",
  accent: "#7c7cf5",
  ok: "#4cb782",
  warn: "#f2c94c",
  bad: "#eb5757",
  info: "#4ea7fc",
  claude: "#d97757",
  soft: "#23234a",
  key: "#26262c",
  onFill: "#0d0d0f",
  onKey: "#e6e6ea",
} as const;

export function palette(mode: ColorMode, contrast = false): Palette {
  if (mode === "none") {
    const none = { text: undefined, dim: undefined, faint: undefined, line: undefined, accent: undefined, ok: undefined, warn: undefined, bad: undefined, info: undefined, claude: undefined };
    return { mode, contrast, fg: none, bg: { accent: undefined, soft: undefined, key: undefined } };
  }
  if (mode === "ansi") {
    // In high contrast, quiet text and lines take the terminal's own foreground: ANSI white vanishes on a light theme.
    const quiet = contrast ? undefined : "gray";
    return {
      mode,
      contrast,
      fg: { text: undefined, dim: quiet, faint: quiet, line: quiet, accent: "blue", ok: "green", warn: "yellow", bad: "red", info: "cyan", claude: "magenta" },
      bg: { accent: undefined, soft: undefined, key: undefined },
    };
  }
  return {
    mode,
    contrast,
    fg: {
      text: undefined,
      dim: contrast ? undefined : HEX.dim,
      faint: contrast ? undefined : HEX.faint,
      line: contrast ? HEX.dim : HEX.line,
      accent: HEX.accent,
      ok: HEX.ok,
      warn: HEX.warn,
      bad: HEX.bad,
      info: HEX.info,
      claude: HEX.claude,
    },
    bg: { accent: HEX.accent, soft: HEX.soft, key: HEX.key },
  };
}

// Text drawn on a fill, which has to be explicit because the fill is.
export const ON_FILL = { accent: HEX.onFill, soft: undefined, key: HEX.onKey } as const;

const TRUECOLOR_TERMS = new Set(["xterm-ghostty", "xterm-kitty", "wezterm"]);
const TRUECOLOR_PROGRAMS = new Set(["ghostty", "iTerm.app", "WezTerm", "vscode"]);

// Apple's Terminal and anything unknown get the 16 names: a wrong guess at truecolor shows the wrong colors.
export function detectMode(env: Record<string, string | undefined>): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (env.TERM && TRUECOLOR_TERMS.has(env.TERM)) return "truecolor";
  if (env.TERM_PROGRAM && TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM)) return "truecolor";
  return "ansi";
}

export const wantsHighContrast = (env: Record<string, string | undefined>, argv: string[]) =>
  argv.includes("--high-contrast") || env.ATRIUM_HIGH_CONTRAST === "1";

let current: Palette = palette(detectMode(process.env), wantsHighContrast(process.env, process.argv));
export const theme = () => current;
export const setTheme = (p: Palette) => {
  current = p;
};

// The roles screens and detail lines color by.
export const color = { accent: "accent", ok: "ok", warn: "warn", bad: "bad", muted: "dim", faint: "faint", info: "info" } as const satisfies Record<string, Tone>;

// Status words and glyphs; the word always shows too, so color is never the only signal.
export const STATUS_GLYPH: Record<TaskStatus, { glyph: string; color: Tone }> = {
  running: { glyph: "●", color: "ok" },
  queued: { glyph: "○", color: "faint" },
  review: { glyph: "◆", color: "accent" },
  done: { glyph: "✓", color: "faint" },
  failed: { glyph: "✗", color: "bad" },
  blocked: { glyph: "!", color: "bad" },
};

// Single-width symbols only; emoji widths vary between terminals and break the box edges.
export const GLYPH = {
  logo: "◆",
  dot: "●",
  arrow: "→",
  pointer: "›",
  sel: "▌",
  bar: "█",
  barEmpty: "░",
  meter: "▰",
  meterEmpty: "▱",
  ellipsis: "…",
  suggestion: "✦",
  ok: "✓",
  bad: "✗",
  // A result the agent said it couldn't or only partly do, and every warning.
  notdone: "!",
  up: "▲",
  down: "▼",
} as const;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPACE_TONES: Tone[] = ["info", "ok", "claude", "accent", "warn", "bad"];
// A space's stored color is hex for the dashboard; here the hue comes from its position instead.
export const spaceTone = (index: number): Tone => SPACE_TONES[((index % SPACE_TONES.length) + SPACE_TONES.length) % SPACE_TONES.length]!;

const MAX_METER = 10;

// Claude's five-hour window as a meter: filled cells for what's used, and a word when tasks have started waiting.
export function windowGauge(state: State, cols: number): { label: string; filled: number; empty: number; pct: string; tone: "ok" | "warn" | "muted" } | { text: string; tone: "muted" } {
  const w = state.claudeWindow;
  if (!w) return { text: truncate("Claude · no reading yet", cols), tone: "muted" };
  const used = Math.min(1, Math.max(0, w.utilization));
  const pct = ` ${Math.round(used * 100)}%${used >= w.reserve ? " · paused" : ""}`;
  const tone = used >= w.reserve ? "warn" : "ok";
  const label = "Claude ";
  const cells = Math.min(MAX_METER, cols - label.length - pct.length);
  if (cells < 3) return { text: truncate(`Claude${pct}`, cols), tone: "muted" };
  const filled = Math.round(used * cells);
  return { label, filled, empty: cells - filled, pct, tone };
}
