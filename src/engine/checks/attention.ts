import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { changedText, fileAt, outsideGit, treeEntries } from "../git";
import { type Check, touchesInstallConfig } from "./detect";

// Files that decide how a project's checks run: manifests and lockfiles, build files, test runner and linter
// config, CI. Matched on the file name wherever it sits, with case folded: APFS is case-insensitive, so
// MAKEFILE is the Makefile.
const CONFIG_NAMES = new Set([
  "package.json", "makefile", "gnumakefile", "pyproject.toml", "setup.cfg", "setup.py", "tox.ini", "pytest.ini", "conftest.py",
  "noxfile.py", "cargo.toml", "cargo.lock", "go.mod", "go.sum", "bunfig.toml", "deno.json", "biome.json", ".mocharc.json", ".mocharc.js",
  "claude.md", "agents.md", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "uv.lock", "poetry.lock",
]);
const CONFIG_PATTERNS = [
  /\.mk$/,
  /^(jest|vitest|vite|playwright|karma|ava|cypress)\.config\.[cm]?[jt]s$/,
  /^(\.eslintrc(\..+)?|eslint\.config\.[cm]?[jt]s|\.prettierrc(\..+)?|tsconfig(\..+)?\.json|\.?mypy\.ini|\.?ruff\.toml|clippy\.toml)$/,
  /^(babel\.config\.[cm]?[jt]s(on)?|\.babelrc(\..+)?|jest\.config\.json|vitest\.workspace\.[cm]?[jt]s(on)?)$/,
];
const CI_DIRS = /^(\.github\/workflows|\.circleci|\.buildkite|ci|scripts)\//;

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;
const SKIP_MARKERS = /\b(?:describe|it|test)\.(?:skip|todo)\(|\bx(?:it|describe|test)\(|@pytest\.mark\.(?:skip|xfail)|\bt\.Skip\(|#\[ignore\]|@(?:Disabled|Ignore)\b/;
// Ways to silence a typechecker or linter in place, the usual shortcut when one fails.
const SUPPRESSIONS = /@ts-(?:nocheck|ignore|expect-error)\b|\beslint-disable\b|#\s*type:\s*ignore\b|#\s*noqa\b|#\s*pylint:\s*disable\b|#!?\[allow\(|\/\/\s*nolint\b|@SuppressWarnings\b|biome-ignore\b/;

// Paths a check names (`./scripts/test.sh`, `bin/lint`) in its command or in the pinned Makefile recipes it runs,
// which define the check as much as its config. Best effort: a path built at run time isn't seen.
function scriptsCalled(checks: Check[]): Set<string> {
  const paths = new Set<string>();
  const texts = checks.flatMap((c) => [c.command, ...Object.values(c.files ?? {})]);
  for (const text of texts) {
    for (const word of text.split(/[\s;&|()"'`]+/)) {
      if (/^\.?\/?[\w.-]+\/[\w./-]+$/.test(word) || /^[\w.-]+\.(sh|py|js|mjs|cjs|ts|rb|pl)$/.test(word)) paths.add(word.replace(/^\.\//, "").toLowerCase());
    }
  }
  return paths;
}

// Files a project's tsconfig, ESLint or Jest JSON config pulls in through `extends`, read from the base commit and
// followed to the end of the chain. Relative paths only: a package's config lives in node_modules, out of reach.
async function extendedConfig(repo: string, base: string, tree: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const files = new Set(tree);
  const queue = tree.filter((p) => /(^|\/)(tsconfig[^/]*\.json|\.eslintrc(\.json)?|jest\.config\.json)$/i.test(p));
  while (queue.length && found.size < 50) {
    const file = queue.shift()!;
    let parsed: { extends?: unknown };
    try {
      // These files allow comments and trailing commas; both are taken out before parsing.
      const text = (await fileAt(repo, base, file)).text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    for (const ext of [parsed.extends].flat()) {
      if (typeof ext !== "string" || !ext.startsWith(".")) continue;
      const target = [normalize(join(dirname(file), ext)), normalize(join(dirname(file), `${ext}.json`))].find((p) => files.has(p));
      if (target && !found.has(target)) {
        found.add(target);
        queue.push(target);
      }
    }
  }
  return found;
}

// Config any tool reads, by name: what the checks run with and how dependencies install. Case is folded, as APFS
// does.
export function isConfig(path: string, extra: Set<string> = new Set()): boolean {
  const p = path.toLowerCase();
  const name = basename(p);
  return CONFIG_NAMES.has(name) || CONFIG_PATTERNS.some((re) => re.test(name)) || CI_DIRS.test(p) || extra.has(p) || touchesInstallConfig([p]).length > 0;
}

// Config files outside git (ignored, or untracked) as they are now, by content hash. Taken when a task starts, so
// files that were already there unchanged are never put down to the task.
export async function outsideSnapshot(repo: string): Promise<Record<string, string>> {
  const snap: Record<string, string> = {};
  for (const path of await outsideGit(repo)) {
    const abs = join(repo, path);
    if (isConfig(path) && existsSync(abs)) snap[path] = createHash("sha256").update(readFileSync(abs)).digest("hex");
  }
  return snap;
}

// Config files outside git that are new or different since the snapshot.
export async function changedOutside(repo: string, before: Record<string, string>): Promise<string[]> {
  const now = await outsideSnapshot(repo);
  return Object.keys(now).filter((p) => before[p] !== now[p]);
}

// Ways a change can make a gate pass without making the code better: editing how the checks run (directly, through
// a config's `extends`, or through a script a check or its Makefile calls), removing test files, skipping tests, or
// silencing a checker in place. None of them fails the gate, since each can be right; each is named on the result,
// pointed out to the reviewer, and keeps a rule from approving it on its own. `committed` are the paths the
// branch changed against `base`; `outside` the config files the work left outside git (changedOutside).
export async function checkAttention(repo: string, base: string, head: string, committed: string[], outside: string[], checks: Check[]): Promise<string[]> {
  const baseTree = (await treeEntries(repo, base)).map((e) => e.path);
  const extra = new Set([...scriptsCalled(checks), ...[...(await extendedConfig(repo, base, baseTree))].map((p) => p.toLowerCase())]);
  const config = committed.filter((p) => isConfig(p, extra));
  const notes: string[] = [];
  if (config.length) notes.push(`This change edits how checks run: ${list(config)}.`);
  if (outside.length) notes.push(`This change leaves config outside git in your checkout: ${list(outside)}. Atrium's checks don't see it, but your own commands there will.`);
  const tests = (paths: string[]) => paths.filter((p) => TEST_FILE.test(p)).length;
  const [before, after] = [tests(baseTree), tests((await treeEntries(repo, head)).map((e) => e.path))];
  if (after < before) notes.push(`This change removes test files: ${before} before, ${after} now.`);
  const added = (await changedText(repo, base, head)).added;
  if (added.some((line) => SKIP_MARKERS.test(line))) notes.push("This change marks tests as skipped.");
  const silenced = [...new Set(added.flatMap((line) => line.match(SUPPRESSIONS)?.[0] ?? []))];
  if (silenced.length) notes.push(`This change silences a checker in place (${silenced.join(", ")}).`);
  return notes;
}

const list = (paths: string[]) => (paths.length > 4 ? `${paths.slice(0, 4).join(", ")} and ${paths.length - 4} more` : paths.join(", "));
