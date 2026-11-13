import { fileAt, treeEntries } from "../git";

export type CheckKind = "fast" | "full";
// `files` are copies of the base commit's files a command reads (a Makefile), put in a folder of their own and
// named through $ATRIUM_CHECK_FILES, so the copy in the agent's tree is never what runs.
export type Check = { name: string; command: string; kind: CheckKind; files?: Record<string, string> };

// Read from the commit the task started from, never the agent's branch, and run as that exact text: an agent that
// rewrote the test script to `exit 0` mustn't get to choose what proves its work.
const cache = new Map<string, Check[]>();

export async function detectChecks(repo: string, sha: string): Promise<Check[]> {
  const key = `${repo}\0${sha}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const found = await detect(repo, sha);
  cache.set(key, found);
  return found;
}

type Command = string | { command: string; files: Record<string, string> };
type Found = Partial<Record<"typecheck" | "lint" | "test", Command>>;

async function detect(repo: string, sha: string): Promise<Check[]> {
  const all = new Set((await treeEntries(repo, sha)).map((e) => e.path));
  const read = async (file: string) => (all.has(file) ? (await fileAt(repo, sha, file)).text : null);
  const root = new Set([...all].filter((p) => !p.includes("/")));
  // Earlier sources win for each kind: what the project scripts say, then what its notes for agents say, then
  // what the toolchain implies.
  const sources: Found[] = [
    await fromPackageJson(read, root, all),
    hintsFrom(`${(await read("CLAUDE.md")) ?? ""}\n${(await read("AGENTS.md")) ?? ""}`),
    fromMakefile(await read("Makefile")),
    await fromPyproject(read, root, all),
    root.has("Cargo.toml") ? { typecheck: "cargo check", lint: "cargo clippy", test: "cargo test" } : {},
    root.has("go.mod") ? { typecheck: "go vet ./...", test: "go test ./..." } : {},
  ];
  const pick = (kind: keyof Found) => sources.find((s) => s[kind])?.[kind];
  const checks: Check[] = [];
  for (const [kind, name, cost] of [["typecheck", "Typecheck", "fast"], ["lint", "Lint", "fast"], ["test", "Tests", "full"]] as const) {
    const found = pick(kind);
    if (typeof found === "string") checks.push({ name, command: found, kind: cost });
    else if (found) checks.push({ name, command: found.command, kind: cost, files: found.files });
  }
  return checks;
}

const PM_LOCKS: [string, string][] = [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]];

async function fromPackageJson(read: (f: string) => Promise<string | null>, root: Set<string>, all: Set<string>): Promise<Found> {
  const raw = await read("package.json");
  if (raw === null) return {};
  let pkg: { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return {};
  }
  const pm = PM_LOCKS.find(([lock]) => root.has(lock))?.[1] ?? "npm";
  const scripts = pkg.scripts ?? {};
  const script = (...names: string[]) => names.find((n) => typeof scripts[n] === "string" && scripts[n]);
  // The script's own text from the base commit, run with node_modules/.bin on PATH the way `npm run` would, not
  // `npm run <name>`, which would read whatever the agent's package.json says now.
  const run = (name: string) => String(scripts[name]);
  const found: Found = {};
  const typecheck = script("typecheck", "type-check", "check-types", "tsc");
  if (typecheck) found.typecheck = run(typecheck);
  else if (root.has("tsconfig.json") && ("typescript" in (pkg.devDependencies ?? {}) || "typescript" in (pkg.dependencies ?? {}))) {
    found.typecheck = `${pm === "bun" ? "bunx" : "npx"} tsc --noEmit`;
  }
  const lint = script("lint");
  if (lint) found.lint = run(lint);
  // npm's placeholder test script only fails, so it isn't a test command.
  const test = script("test");
  if (test && !/no test specified/.test(String(scripts[test]))) found.test = run(test);
  else if (pm === "bun" && [...all].some((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p))) found.test = "bun test";
  return found;
}

const COMMAND = /`((?:bun|bunx|npm|npx|pnpm|yarn|make|cargo|go|pytest|uv|poetry|ruff|mypy|python3?)\s[^`\n]+)`/g;

// The commands a project's notes for agents name in backticks, sorted by what they do.
export function hintsFrom(text: string): Found {
  const found: Found = {};
  for (const m of text.matchAll(COMMAND)) {
    const cmd = m[1]!.trim();
    if (!found.typecheck && /\b(tsc|typecheck|type-check|mypy|cargo check|go vet)\b/.test(cmd)) found.typecheck = cmd;
    else if (!found.lint && /\b(lint|ruff|clippy|eslint)\b/.test(cmd)) found.lint = cmd;
    else if (!found.test && /\b(test|pytest)\b/.test(cmd)) found.test = cmd;
  }
  return found;
}

function fromMakefile(text: string | null): Found {
  if (!text) return {};
  const targets = new Set([...text.matchAll(/^([A-Za-z0-9_-]+)\s*:(?!=)/gm)].map((m) => m[1]!));
  const make = (target: string) => ({ command: `make -f "$ATRIUM_CHECK_FILES/Makefile" ${target}`, files: { Makefile: text } });
  const found: Found = {};
  if (targets.has("typecheck")) found.typecheck = make("typecheck");
  else if (targets.has("check")) found.typecheck = make("check");
  if (targets.has("lint")) found.lint = make("lint");
  if (targets.has("test")) found.test = make("test");
  return found;
}

async function fromPyproject(read: (f: string) => Promise<string | null>, root: Set<string>, all: Set<string>): Promise<Found> {
  const text = await read("pyproject.toml");
  if (text === null) return {};
  const prefix = root.has("uv.lock") ? "uv run " : root.has("poetry.lock") ? "poetry run " : "";
  const found: Found = {};
  if (/\[tool\.mypy\]|\bmypy\b/.test(text)) found.typecheck = `${prefix}mypy .`;
  if (/\[tool\.ruff|\bruff\b/.test(text)) found.lint = `${prefix}ruff check .`;
  if (/\[tool\.pytest|\bpytest\b/.test(text) || [...all].some((p) => /(^|\/)test_[^/]+\.py$/.test(p))) found.test = `${prefix}pytest`;
  return found;
}

// A space's own commands, one per line: the first ones are fast and the last is the full test run.
export function overrideChecks(text: string): Check[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6);
  return lines.map((command, i) => ({ name: command, command, kind: i === lines.length - 1 ? "full" : "fast" }));
}

// What the gate runs for a task: the space's own list if it has one, else what the repo says, with the brief's
// verify command in place of the test run.
export function checksFor(detected: Check[], opts: { spaceChecks: string | null; verify: string | null }): Check[] {
  const base = opts.spaceChecks ? overrideChecks(opts.spaceChecks) : detected;
  if (!opts.verify || opts.verify === "auto") return base;
  return [...base.filter((c) => c.kind === "fast"), { name: "Verify", command: opts.verify, kind: "full" }];
}
