import { expect, test } from "bun:test";
import type { State } from "../../src/engine/state";
import { paint } from "../../src/tui/components/Screen";
import { detectMode, palette, STATUS_GLYPH, type Tone, wantsHighContrast, windowGauge } from "../../src/tui/theme";
import { width } from "../../src/tui/text";

const ANSI = new Set(["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray"].flatMap((c) => (c === "gray" ? [c] : [c, `${c}Bright`])));
const TONES: Tone[] = ["text", "dim", "faint", "line", "accent", "ok", "warn", "bad", "info", "claude"];
const withWindow = (utilization: number | null) =>
  ({ claudeWindow: utilization === null ? null : { utilization, resetsAt: Date.now() + 3600_000, reserve: 0.5 }, usage: { claudeTokens24h: 0, claudeReserve: 0.5 } }) as unknown as State;

test("truecolor where the terminal says so, 16 colors elsewhere, nothing under NO_COLOR", () => {
  expect(detectMode({ COLORTERM: "truecolor" })).toBe("truecolor");
  expect(detectMode({ COLORTERM: "24bit" })).toBe("truecolor");
  expect(detectMode({ TERM: "xterm-ghostty" })).toBe("truecolor");
  expect(detectMode({ TERM_PROGRAM: "iTerm.app" })).toBe("truecolor");
  expect(detectMode({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" })).toBe("ansi");
  expect(detectMode({})).toBe("ansi");
  expect(detectMode({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
  expect(detectMode({ NO_COLOR: "" })).toBe("ansi");
  expect(wantsHighContrast({}, ["bun", "cli.ts", "--high-contrast"])).toBe(true);
  expect(wantsHighContrast({ ATRIUM_HIGH_CONTRAST: "1" }, [])).toBe(true);
  expect(wantsHighContrast({}, [])).toBe(false);
});

test("truecolor is Atrium's own palette; text always keeps the terminal's foreground", () => {
  const p = palette("truecolor");
  expect(p.fg.accent).toBe("#7c7cf5");
  expect(p.fg.ok).toBe("#4cb782");
  expect(p.fg.bad).toBe("#eb5757");
  expect(p.fg.text).toBeUndefined();
  for (const t of TONES) if (p.fg[t]) expect(p.fg[t]).toMatch(/^#[0-9a-f]{6}$/);
});

test("16-color mode uses only ANSI names, and never paints a background", () => {
  const p = palette("ansi");
  for (const t of TONES) if (p.fg[t]) expect(ANSI.has(p.fg[t]!)).toBe(true);
  expect(Object.values(p.bg).every((b) => b === undefined)).toBe(true);
  // A chip it can't fill is inverse instead; a key cap is bold accent text.
  expect(paint({ text: " 1 Home ", bg: "accent" }, p)).toMatchObject({ inverse: true, bold: true, backgroundColor: undefined });
  expect(paint({ text: " a ", bg: "key" }, p)).toMatchObject({ color: "blue", bold: true, inverse: false });
});

test("NO_COLOR keeps selection readable without any color", () => {
  const p = palette("none");
  for (const t of TONES) expect(p.fg[t]).toBeUndefined();
  expect(paint({ text: "x", color: "accent", bg: "soft" }, p)).toMatchObject({ color: undefined, inverse: true });
});

test("high contrast lifts quiet text to the foreground and makes accents bold", () => {
  const p = palette("truecolor", true);
  expect(p.fg.dim).toBeUndefined();
  expect(p.fg.faint).toBeUndefined();
  expect(p.fg.line).toBe("#9c9ca6");
  expect(paint({ text: "x", color: "accent" }, p).bold).toBe(true);
  expect(palette("ansi", true).fg.faint).toBeUndefined();
});

test("every status has a glyph of its own", () => {
  expect(new Set(Object.values(STATUS_GLYPH).map((g) => g.glyph)).size).toBe(Object.keys(STATUS_GLYPH).length);
});

test("windowGauge fills cells for what's used and says when Claude tasks are paused", () => {
  const ok = windowGauge(withWindow(0.41), 30);
  expect(ok).toMatchObject({ filled: 4, empty: 6, pct: " 41%", tone: "ok" });
  expect(windowGauge(withWindow(0.62), 30)).toMatchObject({ pct: " 62% · paused", tone: "warn" });
  expect(windowGauge(withWindow(null), 30)).toEqual({ text: "Claude · no reading yet", tone: "muted" });
  for (let cols = 8; cols <= 40; cols++) {
    const g = windowGauge(withWindow(0.41), cols);
    const w = "text" in g ? width(g.text) : g.label.length + g.filled + g.empty + g.pct.length;
    expect(w).toBeLessThanOrEqual(cols);
  }
});
