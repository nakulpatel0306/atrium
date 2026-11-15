import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// An effect written as `() => expr` returns expr's value, and React calls whatever an effect returns as its cleanup.
// Chrome's scrollIntoView now returns a promise, which crashed the whole page the moment the command palette's
// effect re-ran. Effects take a block body, or `void`, so they never return a value by accident.
test("no effect returns a value by accident", () => {
  const dir = join(import.meta.dir, "..", "..", "src", "dashboard");
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f));
  const bad = files.flatMap((f) =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .flatMap((line, i) => (/useEffect\(\(\) => (?![{]|void )/.test(line) ? [`${f}:${i + 1}`] : [])),
  );
  expect(bad).toEqual([]);
});
