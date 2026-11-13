import { basename } from "node:path";
import { branchFiles, changedText, treeEntries } from "../git";
import type { Check } from "./detect";

// Files that decide how a project's checks run: manifests, build files, test runner and linter config, CI.
// Matched on the file name, wherever it sits in the repo.
const CONFIG_NAMES = new Set([
  "package.json", "Makefile", "GNUmakefile", "pyproject.toml", "setup.cfg", "setup.py", "tox.ini", "pytest.ini", "conftest.py",
  "noxfile.py", "Cargo.toml", "go.mod", "bunfig.toml", "deno.json", "biome.json", ".mocharc.json", ".mocharc.js", "CLAUDE.md", "AGENTS.md",
]);
const CONFIG_PATTERNS = [
  /\.mk$/,
  /^(jest|vitest|vite|playwright|karma|ava|cypress)\.config\.[cm]?[jt]s$/,
  /^(\.eslintrc(\..+)?|eslint\.config\.[cm]?[jt]s|\.prettierrc(\..+)?|tsconfig(\..+)?\.json|\.?mypy\.ini|\.?ruff\.toml|clippy\.toml)$/,
];
const CI_DIRS = /^(\.github\/workflows|\.circleci|\.buildkite|ci|scripts)\//;

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
const SKIP_MARKERS = /\b(?:describe|it|test)\.(?:skip|todo)\(|\bx(?:it|describe|test)\(|@pytest\.mark\.(?:skip|xfail)|\bt\.Skip\(|#\[ignore\]|@(?:Disabled|Ignore)\b/;

// Paths a check command names (`./scripts/test.sh`, `bin/lint`), which define the check as much as its config.
function scriptsCalled(checks: Check[]): Set<string> {
  const paths = new Set<string>();
  for (const c of checks) for (const word of c.command.split(/\s+/)) if (/^\.?\/?[\w.-]+\/[\w./-]+$/.test(word)) paths.add(word.replace(/^\.\//, ""));
  return paths;
}

// Ways a change can make a gate pass without making the code better: editing how the checks run, removing test
// files, or skipping tests. None of them fails the gate, since each can be right; each is named on the result,
// pointed out to the reviewer, and keeps a rule from approving it on its own.
export async function checkAttention(repo: string, base: string, head: string, checks: Check[]): Promise<string[]> {
  const files = await branchFiles(repo, base, head);
  const called = scriptsCalled(checks);
  const config = files
    .map((f) => f.path)
    .filter((p) => CONFIG_NAMES.has(basename(p)) || CONFIG_PATTERNS.some((re) => re.test(basename(p))) || CI_DIRS.test(p) || called.has(p));
  const notes: string[] = [];
  if (config.length) notes.push(`This change edits how checks run: ${list(config)}.`);
  const tests = async (sha: string) => (await treeEntries(repo, sha)).filter((e) => TEST_FILE.test(e.path)).length;
  const [before, after] = [await tests(base), await tests(head)];
  if (after < before) notes.push(`This change removes test files: ${before} before, ${after} now.`);
  if ((await changedText(repo, base, head)).added.some((line) => SKIP_MARKERS.test(line))) notes.push("This change marks tests as skipped.");
  return notes;
}

const list = (paths: string[]) => (paths.length > 4 ? `${paths.slice(0, 4).join(", ")} and ${paths.length - 4} more` : paths.join(", "));
