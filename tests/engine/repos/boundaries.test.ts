import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Static checks that repo powers (gh, pushing, credentials) live in the few files built to guard them.
const SRC = join(import.meta.dir, "..", "..", "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(e) ? [p] : [];
  });
}

const all = files(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, "utf8") }));
const containing = (needle: string | RegExp) =>
  all.filter((f) => (typeof needle === "string" ? f.text.includes(needle) : needle.test(f.text))).map((f) => f.rel).sort();

test("ghBin is read only by config and the gh wrapper", () => {
  expect(containing("ghBin")).toEqual(["engine/config.ts", "engine/repos/gh.ts"]);
});

// approvals.ts names "push" only as an always-ask kind.
test('the literal "push" appears only in the two push paths and the always-ask list', () => {
  expect(containing('"push"')).toEqual(["engine/approvals.ts", "engine/git.ts", "engine/repos/push.ts"]);
});

test("credential.helper appears only in the gh wrapper", () => {
  expect(containing("credential.helper")).toEqual(["engine/repos/gh.ts"]);
});

test("agent-facing code never imports the repo executors", () => {
  const guarded = all.filter(
    (f) =>
      ["engine/runner.ts", "engine/handoff.ts", "engine/setup.ts"].includes(f.rel) ||
      f.rel.startsWith("engine/agents/") ||
      f.rel.startsWith("engine/markets/"),
  );
  expect(guarded.length).toBeGreaterThan(5);
  for (const f of guarded) expect(f.text).not.toMatch(/from "[^"]*repos\/(create|cleanup|push|gitops)"/);
});
