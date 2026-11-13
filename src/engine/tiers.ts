import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "./settings";

// Which Claude model does which job. A cheap model reads and summarises, the user's own model writes, and a strong
// one judges: review, a writer that got stuck, and picking between attempts. Codex and Gemini use their own models.
export type Tier = "cheap" | "default" | "strong";
export const TIERS: readonly Tier[] = ["cheap", "default", "strong"];

// Defaults that work on a plain Claude subscription. The default tier's "" is whatever model Claude Code is set to,
// so writing uses the user's own choice.
export const TIER_DEFAULTS: Record<Tier, string> = { cheap: "haiku", default: "", strong: "opus" };

// Claude Code falls back to this when the strong model isn't on the user's plan or is busy, rather than failing.
export const STRONG_FALLBACK = "sonnet";

export const TIER_JOBS: Record<Tier, string> = {
  cheap: "Briefs and the workflow it picks, scouts, explanations",
  default: "Writing",
  strong: "Review, a writer after a pause, judging attempts",
};

// A CLI alias ("haiku") or a full model name; nothing that could read as a flag.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
export const validModel = (m: string): boolean => m === "" || MODEL.test(m);

const key = (tier: Tier) => `tiers.${tier}`;

// A stored value that isn't a model name reads as the default.
export function tierModel(db: Database, tier: Tier): string {
  const v = getSetting(db, key(tier));
  return v !== null && validModel(v) ? v : TIER_DEFAULTS[tier];
}

export function setTierModel(db: Database, tier: Tier, model: string): void {
  if (!validModel(model)) throw new Error(`"${model}" isn't a model name Claude Code takes.`);
  setSetting(db, key(tier), model);
}

// What a Claude run at this tier is started with.
export function tierRun(db: Database, tier: Tier): { model?: string; fallbackModel?: string } {
  const model = tierModel(db, tier);
  if (!model) return {};
  return tier === "strong" && model !== STRONG_FALLBACK ? { model, fallbackModel: STRONG_FALLBACK } : { model };
}
