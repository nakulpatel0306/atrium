// The copy rules in docs/copy-inventory.md, as checks over extracted strings.
import { type Found, sourceFiles, swiftStrings, userStrings } from "./strings";

type S = Found & { end: boolean };
export type Offence = { file: string; line: number; text: string; rule: string };

const PROPER = new Set(["Atrium", "Calendar", "Finder", "Claude", "Codex", "Gemini", "GitHub", "TFSA", "Mac", "Needs", "Auto", "Preview", "TextEdit", "Wealthsimple", "TradingView", "System", "Settings", "Messages", "Contacts", "Finnhub", "Tiingo", "Alpaca", "Alpha", "Vantage", "SPY", "XEQT", "ETF", "CSV", "PR", "OK", "US", "CAD", "USD", "I"]);
const CLI_WORDS = ["install", "log in", "logged out", "logged in", "update", "sandbox", "`claude`", "sign in", "signed in"];
const ERROR_START = /^(Error:|Error |Failed to |Unable to |Something went wrong)/;

export function check(s: S, swift: boolean): string[] {
  const t = s.text;
  const rules: string[] = [];
  // Punctuation alone ("...", ". ") is code: a git range, a separator.
  if (!/[A-Za-z]/.test(t)) return rules;
  // Go's `./...` package pattern is part of a command, not trailing copy.
  if (t.replace(/\.\/\.\.\./g, "").includes("...")) rules.push("no-ascii-ellipsis");
  if (/[.!?] {2,}\S/.test(t) || (!s.file.startsWith("src/tui/") && /\w {2,}\w/.test(t))) rules.push("one-space-after-stop");
  // Allowed when the message goes on past its first sentence ("Something went wrong in Atrium. Check the engine log.").
  if (ERROR_START.test(t) && !/[.!?] \S/.test(t)) rules.push("no-error-prefix");
  if (s.end && /[.!?] +$/.test(t)) rules.push("no-trailing-space-sentence");
  if (swift) return rules;
  if (s.call && s.end && !/[.!?]["')]*$/.test(t.trim())) rules.push("errors-end-in-a-stop");
  if (s.inButton) {
    const words = t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
    if (words.slice(1).some((w) => /^[A-Z][a-z]/.test(w) && !PROPER.has(w.replace(/['’]s$/, "").replace(/[^A-Za-z]/g, "")))) rules.push("button-sentence-case");
  }
  if (t.includes("Claude Code") && !s.file.startsWith("src/engine/agents/") && !CLI_WORDS.some((w) => t.toLowerCase().includes(w))) rules.push("claude-code-only-for-cli");
  return rules;
}

export function offences(): Offence[] {
  const ts = userStrings(sourceFiles(["src"], /\.tsx?$/));
  const swift = swiftStrings(sourceFiles(["mac/Sources"], /\.swift$/));
  return [...ts.flatMap((s) => check(s, false).map((rule) => ({ ...s, rule }))), ...swift.flatMap((s) => check(s, true).map((rule) => ({ ...s, rule })))].map(
    ({ file, line, text, rule }) => ({ file, line, text, rule }),
  );
}
