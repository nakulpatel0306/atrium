import type { ALWAYS_ASK } from "../approvals";
import { isEnvPath } from "../envpath";
import type { ChangedFile } from "../git";
import { agentName } from "../text";

export const SMALL_LINES = 50;
export const MEDIUM_LINES = 200;
export const STREAK = 5;
export const STREAK_WINDOW_MS = 14 * 86_400_000;
export const RULE_TTL_MS = 60 * 86_400_000;
export const DAILY_CAP = 10;
export const DOCS_BYTES = 20 * 1024;

// What a docs change contains and where it lands, read from the commit that was classified.
export type DocsContent = {
  added: string[];
  // Bytes added plus bytes removed, over every changed line.
  bytes: number;
  // The tree has a docs site generator, a build or test setting that runs Markdown (Docusaurus, Sphinx, Hugo, Cargo
  // doc tests, pytest doctests…), or a config file Atrium couldn't read in full.
  siteConfig: boolean;
  // Some agent instruction file imports another file with @, isn't a plain file, or couldn't be read in full, so an
  // edit to any docs file might be an edit to an agent's instructions.
  instructionsUnsafe: boolean;
  // The tree has a symlink, a submodule, or an agent or editor config folder anywhere: not a plain repo.
  notPlain: boolean;
  // A touched file's whole new text has a doctest prompt, a continuation line or an rST directive, or couldn't be
  // read in full.
  bodyUnsafe: boolean;
};

// What the engine itself saw about a result, at one commit (`sha`). Nothing here comes from the agent's own words.
export type ActionFacts =
  | { domain: "code"; agent: string; branch: string; sha: string; files: ChangedFile[]; content: DocsContent }
  | { domain: "general"; agent: string; filesKept: number };

export type ForbiddenReason = (typeof ALWAYS_ASK)[number];

// The grammar's second-level words are versioned so a later shape (say, tests) can return without touching old rows.
type Kind =
  | { domain: "code"; shape: "docs"; size: "small" | "medium"; agent: string }
  | { domain: "general"; agent: string };

const AGENTS = new Set(["claude", "codex", "gemini"]);

const SECRET =
  /(^|\/)(id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|[^/]*\.(pem|key|p12|pfx|jks|keystore)|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const DEPLOY =
  /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.ya?ml$|vercel\.json$|netlify\.toml$|fly\.toml$|wrangler\.toml$|render\.ya?ml$|procfile$|dockerfile[^/]*$|docker-compose[^/]*$)/i;
// An agent must never get its own instructions (or another tool's) approved without Nakul looking. The docs
// allowlist below already leaves these out; this list stays as a second check.
const INSTRUCTIONS = [
  /(^|\/)(claude|agents?|gemini|copilot|cursor|windsurf|conventions\.md$|\.aider)[^/]*$/i,
  /(^|\/)(\.cursorrules|\.windsurfrules|\.clinerules|\.mcp\.json)(\/|$)/i,
  /(^|\/)\.(claude|codex|gemini|cursor|agents|github|windsurf|roo|continue|kiro|junie)\//i,
];
// Only prose that nothing executes or imports: Markdown or reStructuredText (not .mdx, which can carry
// imports and JSX), either in the top-level docs/ folder or a well-known file such as a README. Tests are code.
const DOCS_EXT = /\.(md|markdown|rst)$/i;
const DOCS_NAME = /^(readme|changelog|contributing|history)[^/]*$/i;
// Markdown that a docs tool would run or expand: MDX-style imports and exports, script tags, template tags, doctest
// prompts, and reStructuredText directives that pull in or run other content.
const EXECUTES = [
  /^\s*(import|export)\s/,
  /<script/i,
  /\{\{/,
  /\{%/,
  /^\s*>>>/,
  /^\s*iex(\(\d+\))?>/,
  // Any directive, whatever its name: `.. code block::` and `.. sphinx.ext.x::` must not slip past a name list.
  /^\s*\.\.\s+.*::/,
];
const SITE_CONFIG =
  /(^|\/)(docusaurus\.config\.[^/]+|astro\.config\.[^/]+|nuxt\.config\.[^/]+|gatsby-config\.[^/]+|mkdocs\.ya?ml|cargo\.toml|mix\.exs|conf\.py|book\.toml|_config\.yml|hugo\.(toml|ya?ml|json))$|(^|\/)\.vitepress(\/|$)|^config\.toml$/i;
const DOCTEST_CONFIG = /(^|\/)(pyproject\.toml|setup\.cfg|pytest\.ini|tox\.ini)$/i;
// Files that steer an agent. Generic .github files (CODEOWNERS, workflows) aren't, even though they live beside
// Copilot's instructions.
// The name rule only covers text files, so source such as src/agents/claude.ts isn't taken for instructions.
const AGENT_INSTRUCTIONS = [
  /(^|\/)(claude|agents?|gemini|copilot|cursor|windsurf)[^/]*\.(md|mdc|markdown|txt|rst)$/i,
  /(^|\/)(conventions\.md|\.aider[^/]*)$/i,
  /(^|\/)(\.cursorrules|\.windsurfrules|\.clinerules|\.mcp\.json)(\/|$)/i,
  /(^|\/)\.(claude|codex|gemini|cursor|agents|windsurf|roo|continue|kiro|junie)\//i,
  /(^|\/)\.github\/(copilot-instructions\.md$|(instructions|agents|prompts|chatmodes)\/)/i,
];

const AGENT_CONFIG =
  /(^|\/)(\.(claude|gemini|codex|cursor|windsurf|agents|roo|continue|kiro|junie|vscode)\/|\.aider[^/]*(\/|$)|(\.clinerules|\.cursorrules|\.windsurfrules|\.mcp\.json)(\/|$))/i;
// A superset of EXECUTES, run over each touched file's full text, so executable content that was already there
// refuses the kind too.
const BODY_RUNS = [/>>>/, /^\.\.\. /m, ...EXECUTES.map((re) => new RegExp(re.source, `${re.flags}m`))];

export const isSiteConfig = (path: string) => SITE_CONFIG.test(path);
export const isAgentConfig = (path: string) => AGENT_CONFIG.test(path);
export const bodyRuns = (text: string) => BODY_RUNS.some((re) => re.test(text));
export const isDoctestConfig = (path: string) => DOCTEST_CONFIG.test(path);
// Any mention at all: parsing these formats exactly is where the gaps would be.
export const enablesDoctest = (text: string) => /doctest|markdown-docs|codeblocks/i.test(text);
export const isAgentInstructionFile = (path: string) => AGENT_INSTRUCTIONS.some((re) => re.test(path));
// Any `@path` at the start of a word, the way Claude, Gemini and Codex instruction files import other files.
export const hasImport = (text: string) => /(?:^|[\s(\[])@[^\s`'"()<>\[\]]/.test(text);

// Only ordinary files: symlinks, gitlinks, executable bits and type changes always go to Nakul.
const PLAIN_MODES = new Set(["100644", "000000"]);

export function forbiddenFor(facts: ActionFacts): ForbiddenReason[] {
  if (facts.domain !== "code") return [];
  const reasons = new Set<ForbiddenReason>();
  if (!facts.branch.startsWith("atrium/")) reasons.add("merge_main");
  for (const f of facts.files) {
    if (f.status === "D") reasons.add("delete");
    if (isEnvPath(f.path) || SECRET.test(f.path)) reasons.add("secrets");
    if (DEPLOY.test(f.path)) reasons.add("deploy");
  }
  return [...reasons].sort();
}

function isDocs(f: ChangedFile): boolean {
  if (f.status === "T" || !PLAIN_MODES.has(f.oldMode) || !PLAIN_MODES.has(f.newMode)) return false;
  if (INSTRUCTIONS.some((re) => re.test(f.path)) || !DOCS_EXT.test(f.path)) return false;
  const parts = f.path.split("/");
  // Dot-folders (.github, .changeset, .vitepress…) hold tool config even when it's written in Markdown.
  if (parts.some((p) => p.startsWith("."))) return false;
  return parts[0]!.toLowerCase() === "docs" && parts.length > 1 ? true : DOCS_NAME.test(parts.at(-1)!);
}

export function fingerprintOf(facts: ActionFacts): string | null {
  if (!AGENTS.has(facts.agent) || forbiddenFor(facts).length > 0) return null;
  if (facts.domain === "general") return facts.filesKept === 0 ? `v1:general:text:${facts.agent}` : null;
  if (facts.files.length === 0) return null;
  let lines = 0;
  for (const f of facts.files) {
    if (f.added === null || f.deleted === null) return null;
    lines += f.added + f.deleted;
  }
  if (lines > MEDIUM_LINES || !facts.files.every(isDocs)) return null;
  const c = facts.content;
  if (c.siteConfig || c.instructionsUnsafe || c.notPlain || c.bodyUnsafe || c.bytes > DOCS_BYTES) return null;
  if (c.added.some((line) => EXECUTES.some((re) => re.test(line)))) return null;
  return `v1:code:docs:${lines <= SMALL_LINES ? "small" : "medium"}:${facts.agent}`;
}

// Strict on purpose: a rule can only ever cover what this grammar can say, and it has no word for anything on
// the always-ask list.
export function parseFingerprint(fp: string): Kind | null {
  const parts = fp.split(":");
  if (parts[0] !== "v1") return null;
  if (parts.length === 5 && parts[1] === "code") {
    const [, , shape, size, agent] = parts as [string, string, string, string, string];
    if (shape === "docs" && (size === "small" || size === "medium") && AGENTS.has(agent)) {
      return { domain: "code", shape, size, agent };
    }
  }
  if (parts.length === 4 && parts[1] === "general" && parts[2] === "text" && AGENTS.has(parts[3]!)) {
    return { domain: "general", agent: parts[3]! };
  }
  return null;
}

export function labelOf(fp: string): string {
  const k = parseFingerprint(fp);
  if (!k) return fp;
  if (k.domain === "general") return `text answers with no files from ${agentName(k.agent)}`;
  const size = k.size === "small" ? `up to ${SMALL_LINES} lines` : `of ${SMALL_LINES + 1}–${MEDIUM_LINES} lines`;
  return `docs changes (Markdown in docs/ or a README/CHANGELOG) ${size} from ${agentName(k.agent)}`;
}
