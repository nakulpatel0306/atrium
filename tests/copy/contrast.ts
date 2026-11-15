// WCAG contrast of the dashboard's text tokens on each surface, read from styles.css.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./strings";

// Text and status colours that sit on the surfaces, and the fills that carry white labels.
const TEXT = ["--text", "--dim", "--faint", "--accent", "--green", "--yellow", "--red", "--blue"];
const SURFACES = ["--bg", "--panel", "--raised", "--hover"];
const FILLS = ["--accent-fill", "--danger-fill", "--claude-fill"];

const css = () => readFileSync(join(ROOT, "src", "dashboard", "styles.css"), "utf8");
const hexes = (block: string) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));

export function tokens(): Record<string, string> {
  return hexes(css().match(/:root\s*{([^}]*)}/)![1]!);
}

// The light theme overrides some tokens; the rest carry over from the dark set.
export function lightTokens(): Record<string, string> {
  return { ...tokens(), ...hexes(css().match(/:root\[data-theme="light"\]\s*{([^}]*)}/)![1]!) };
}

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

export const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

export function contrastFailures(): string[] {
  return (["dark", "light"] as const).flatMap((theme) => {
    const t = theme === "dark" ? tokens() : lightTokens();
    const fail = (fg: string, bg: string) => (ratio(t[fg]!, t[bg]!) < 4.5 ? [`${theme}: ${fg} on ${bg}: ${ratio(t[fg]!, t[bg]!).toFixed(2)}:1, needs 4.5:1`] : []);
    return [...TEXT.flatMap((fg) => SURFACES.flatMap((bg) => fail(fg, bg))), ...FILLS.flatMap((bg) => fail("--on-fill", bg))];
  });
}
