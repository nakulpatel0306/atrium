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

// What the engine itself saw about a result. Nothing here comes from the agent's own words.
export type ActionFacts =
  | { domain: "code"; agent: string; branch: string; files: ChangedFile[] }
  | { domain: "general"; agent: string; filesKept: number };

export type ForbiddenReason = (typeof ALWAYS_ASK)[number];

type Kind =
  | { domain: "code"; shape: "docs" | "tests"; size: "small" | "medium"; agent: string }
  | { domain: "general"; agent: string };

const AGENTS = new Set(["claude", "codex", "gemini"]);

const SECRET =
  /(^|\/)(id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|[^/]*\.(pem|key|p12|pfx|jks|keystore)|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const DEPLOY =
  /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.ya?ml$|vercel\.json$|netlify\.toml$|fly\.toml$|wrangler\.toml$|render\.ya?ml$|procfile$|dockerfile[^/]*$|docker-compose[^/]*$)/i;
// An agent must never get its own instructions approved without Nakul looking.
const INSTRUCTIONS = /(^|\/)((claude|agents|gemini)\.md$|\.(claude|codex|gemini|cursor)\/)/i;
const DOCS = /\.(md|mdx|markdown|txt|rst)$/i;
const TESTS = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

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

function shapeOf(path: string): "docs" | "tests" | "code" {
  if (INSTRUCTIONS.test(path)) return "code";
  if (TESTS.test(path)) return "tests";
  return DOCS.test(path) ? "docs" : "code";
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
  if (lines > MEDIUM_LINES) return null;
  const shapes = new Set(facts.files.map((f) => shapeOf(f.path)));
  const shape = shapes.size === 1 ? [...shapes][0]! : "code";
  if (shape === "code") return null;
  return `v1:code:${shape}:${lines <= SMALL_LINES ? "small" : "medium"}:${facts.agent}`;
}

// Strict on purpose: a rule can only ever cover what this grammar can say, and it has no word for anything on
// the always-ask list.
export function parseFingerprint(fp: string): Kind | null {
  const parts = fp.split(":");
  if (parts[0] !== "v1") return null;
  if (parts.length === 5 && parts[1] === "code") {
    const [, , shape, size, agent] = parts as [string, string, string, string, string];
    if ((shape === "docs" || shape === "tests") && (size === "small" || size === "medium") && AGENTS.has(agent)) {
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
  const what = k.shape === "docs" ? "docs-only" : "test-only";
  return `${what} changes under ${k.size === "small" ? SMALL_LINES : MEDIUM_LINES} lines from ${agentName(k.agent)}`;
}
