// What tokens would cost at Anthropic's list prices, as an estimate: a subscription doesn't bill per token, so this
// is what the work would cost on the API, not what the user pays. Shared by the engine and the dashboard, so it
// imports nothing.

// US dollars per million tokens: fresh input, output, cache reads and five-minute cache writes (1.25× input).
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

const price = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

// List prices as of November 2026, by model name. The longest matching prefix wins, so a family's newest model is
// listed before the line that catches its older ones.
const PRICES: [string, Price][] = [
  ["claude-fable-5-2", price(8, 40, 0.2)],
  ["claude-mythos-5-2", price(8, 40, 0.2)],
  ["claude-fable", price(10, 50, 1)],
  ["claude-mythos", price(10, 50, 1)],
  ["claude-opus-5-5", price(4, 20, 0.2)],
  ["claude-opus", price(5, 25, 0.5)],
  ["claude-sonnet-5-5", price(2, 10, 0.1)],
  ["claude-sonnet-5", price(2, 10, 0.2)],
  ["claude-sonnet", price(3, 15, 0.3)],
  ["claude-haiku-5-5", price(0.1, 0.5, 0.01)],
  ["claude-haiku", price(1, 5, 0.1)],
];

// Claude Code's aliases, for a run that reported no per-model totals and so is known only by the model it was asked for.
const ALIASES: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-2" };

// null for a model with no known list price (Codex, Gemini, or a Claude model newer than this table).
export function priceOf(model: string | null): Price | null {
  if (!model) return null;
  const name = model.toLowerCase().replace(/\[.*\]$/, "");
  const full = ALIASES[name] ?? name;
  let best: [string, Price] | null = null;
  for (const entry of PRICES) if (full.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  return best?.[1] ?? null;
}

export type Tokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export function costOf(t: Tokens, model: string | null): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheReadTokens * p.cacheRead + t.cacheWriteTokens * p.cacheWrite) / 1_000_000;
}

// A total of tokens and estimated cost. `unpriced` counts the weighted tokens from models with no list price, so the
// dollar figure is labelled as covering only part of the work. `input` is everything the agents read in, fresh or
// from the cache, and `cacheRead` the part the cache served.
export type Spend = { weighted: number; usd: number; unpriced: number; cacheRead: number; input: number };

export const NO_SPEND: Spend = { weighted: 0, usd: 0, unpriced: 0, cacheRead: 0, input: 0 };

// How much of what the agents read came from the prompt cache; null before anything was read.
export function cacheShare(s: Spend): number | null {
  return s.input > 0 ? s.cacheRead / s.input : null;
}

export function dollars(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd).toLocaleString("en-US")}`;
}

// "~$1.20 est." with what the estimate leaves out, for every surface that shows a cost.
export function spendText(s: Spend): string {
  if (s.weighted === 0) return "nothing yet";
  if (s.unpriced === s.weighted) return "no list price for these agents";
  return `~${dollars(s.usd)} est.${s.unpriced > 0 ? " (part of it)" : ""}`;
}
