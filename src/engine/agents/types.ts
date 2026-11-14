export interface AgentRunInput {
  prompt: string;
  cwd: string;
  systemPrompt: string;
  allowedTools: string[];
  // Review runs must not write; Claude enforces that through allowedTools, Codex through its sandbox.
  mode: "work" | "review";
  // A private space's run: Claude's sandbox also keeps it out of Downloads, Desktop, Documents and any
  // bank export (CSV, OFX, QFX) outside its own folder.
  privateData?: boolean;
  onChunk(text: string): void;
  // Every tool call with its full input, for spotting an agent stuck repeating itself. Display goes through onChunk.
  onTool?(name: string, input: unknown): void;
  signal?: AbortSignal;
  // The model for this run's tier (tiers.ts) and a cap on turns. Only Claude takes them; the fallback is the model
  // Claude Code switches to when this one isn't available on the user's plan.
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  // A session the CLI keeps on disk: started under this id, or resumed from it, so a turn inside the prompt cache's
  // window reads its context from the cache. Without one, nothing is kept. Only Claude takes it.
  session?: { id: string; resume: boolean };
}

// One model's tokens. Claude reports them per model, subagents included; see usage.ts for how a resumed session's
// running totals become one turn's share.
// `cacheWrite1hTokens` is the part of the cache writes that went to the one-hour cache, priced at twice fresh input
// rather than 1.25×; `costUSD` is the CLI's own figure at list prices, when it sends one.
export type ModelTokens = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  costUSD?: number;
};

// Subscription window usage as the CLI reports it; resetsAt is epoch ms.
export type WindowUsage = { utilization: number; resetsAt: number };
export type AgentUsage = { fiveHour?: WindowUsage; sevenDay?: WindowUsage };

export type AgentRunResult =
  | {
      status: "ok";
      summary: string;
      // Fresh input, not counting what was read from or written to the prompt cache, which come separately.
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      // The part of the cache writes that went to the one-hour cache, when the CLI says.
      cacheWrite1hTokens?: number;
      usage?: AgentUsage;
      // Per-model totals for the whole session so far, as Claude reports them; absent from CLIs that don't.
      models?: ModelTokens[];
      // The context the main agent held at its last step, so a long session can be ended before it degrades.
      contextTokens?: number;
    }
  | {
      status: "error";
      kind: "not_installed" | "not_logged_in" | "rate_limited" | "failed";
      message: string;
      retryAfter?: number;
      // A limit hit still reports how much of the window is used.
      usage?: AgentUsage;
      // What the run had used when it ended without a result (a stop, a crash), from its own steps: input and cache
      // exact, output a floor, since steps report output before it's finished.
      models?: ModelTokens[];
    };

export type AgentStatus = { installed: boolean; loggedIn: boolean | null; detail: string };

export interface AgentAdapter {
  id: string;
  label: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  // The signal fires when the check has taken too long; the adapter kills its process then.
  probe?(signal?: AbortSignal): Promise<AgentStatus>;
}
