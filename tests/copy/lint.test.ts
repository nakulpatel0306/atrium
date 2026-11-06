import { expect, test } from "bun:test";
import { check, offences } from "./rules";

test("every user-facing string follows the copy rules", () => {
  expect(offences().map((o) => `${o.file}:${o.line}  ${JSON.stringify(o.text)}  → ${o.rule}`)).toEqual([]);
});

test("each rule catches what it should", () => {
  const s = (text: string, more: Partial<Parameters<typeof check>[0]> = {}) => check({ file: "src/dashboard/x.tsx", line: 1, text, context: "string", end: true, ...more }, false);
  expect(s("Loading...")).toContain("no-ascii-ellipsis");
  expect(s("Saved.  Next")).toContain("one-space-after-stop");
  expect(s("two  spaces")).toContain("one-space-after-stop");
  expect(check({ file: "src/tui/keys.ts", line: 1, text: "j k  move", context: "string", end: true }, false)).toEqual([]);
  expect(s("Failed to save")).toContain("no-error-prefix");
  expect(s("Something went wrong in Atrium. Check the engine log.")).toEqual([]);
  expect(s("Done. ")).toContain("no-trailing-space-sentence");
  expect(s("No such space", { call: "HttpError" })).toContain("errors-end-in-a-stop");
  expect(s("No such space.", { call: "HttpError" })).toEqual([]);
  expect(s("Reveal In Finder", { context: "jsx", inButton: true })).toContain("button-sentence-case");
  expect(s("Reveal in Finder", { context: "jsx", inButton: true })).toEqual([]);
  expect(s("Claude Code is reviewing")).toContain("claude-code-only-for-cli");
  expect(s("Claude Code is logged out. Run `claude` once to log in.")).toEqual([]);
  expect(check({ file: "mac/Sources/App/X.swift", line: 1, text: "Wait...", context: "swift", end: true }, true)).toContain("no-ascii-ellipsis");
});
