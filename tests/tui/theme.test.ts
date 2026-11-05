import { expect, test } from "bun:test";
import { join } from "node:path";
import type { State } from "../../src/engine/state";
import { borderTone, color, spaceColor, STATUS_GLYPH, windowGauge } from "../../src/tui/theme";
import { width } from "../../src/tui/text";

const ANSI = new Set(
  ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray"].flatMap((c) =>
    c === "gray" ? [c] : [c, `${c}Bright`],
  ),
);

const withWindow = (utilization: number | null) =>
  ({
    claudeWindow: utilization === null ? null : { utilization, resetsAt: Date.now() + 3600_000, reserve: 0.5 },
    usage: { claudeTokens24h: 0, claudeReserve: 0.5 },
  }) as unknown as State;

test("windowGauge marks the reserve", () => {
  const ok = windowGauge(withWindow(0.41), 40);
  expect(ok.text).toContain("41%");
  expect(ok.text).toContain("│");
  expect(ok.tone).toBe("ok");
  expect(windowGauge(withWindow(0.62), 40).tone).toBe("warn");
  expect(windowGauge(withWindow(null), 40)).toEqual({ text: "Claude 5h · no reading yet", tone: "muted" });
  for (let cols = 20; cols <= 80; cols++) {
    expect(width(windowGauge(withWindow(0.41), cols).text)).toBeLessThanOrEqual(cols);
    expect(width(windowGauge(withWindow(null), cols).text)).toBeLessThanOrEqual(cols);
  }
});

test("theme uses only ANSI color names", () => {
  expect(ANSI.size).toBe(17);
  for (const c of Object.values(color)) expect(ANSI.has(c)).toBe(true);
  for (const g of Object.values(STATUS_GLYPH)) expect(ANSI.has(g.color)).toBe(true);
  for (let i = 0; i < 12; i++) expect(ANSI.has(spaceColor(i))).toBe(true);
});

test("no hex colors in the terminal app", async () => {
  const dir = join(import.meta.dir, "../../src/tui");
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(dir)) {
    const text = await Bun.file(join(dir, file)).text();
    if (/#[0-9a-fA-F]{3,8}\b|rgb\(|backgroundColor/.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("borders turn red while the engine is unreachable", () => {
  expect(borderTone(true, true)).toBe("blue");
  expect(borderTone(false, true)).toBe("gray");
  expect(borderTone(true, false)).toBe("red");
  expect(borderTone(false, false)).toBe("red");
});
