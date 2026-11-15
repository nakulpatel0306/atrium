import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// An effect written as `() => expr` returns expr's value, and React calls whatever an effect returns as its cleanup.
// In the Chrome used for this project's checks, an effect of the form `() => el.scrollIntoView()` blanked the whole
// page when the command palette re-rendered: React called the value it returned as a cleanup. Effects take a block body, or `void`, so they never return a value by accident.
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
