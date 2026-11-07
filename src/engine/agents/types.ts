export interface AgentRunInput {
  prompt: string;
  cwd: string;
  systemPrompt: string;
  allowedTools: string[];
  // Review runs must not write; Claude enforces that through allowedTools, Codex through its sandbox.
  mode: "work" | "review";
  // A private or investing space's run: Claude's sandbox also keeps it out of Downloads, Desktop, Documents and any
  // bank export (CSV, OFX, QFX) outside its own folder.
  privateData?: boolean;
  onChunk(text: string): void;
  signal?: AbortSignal;
}

// Subscription window usage as the CLI reports it; resetsAt is epoch ms.
export type WindowUsage = { utilization: number; resetsAt: number };
export type AgentUsage = { fiveHour?: WindowUsage; sevenDay?: WindowUsage };

export type AgentRunResult =
  | { status: "ok"; summary: string; inputTokens: number; outputTokens: number; usage?: AgentUsage }
  | {
      status: "error";
      kind: "not_installed" | "not_logged_in" | "rate_limited" | "failed";
      message: string;
      retryAfter?: number;
      // A limit hit still reports how much of the window is used.
      usage?: AgentUsage;
    };

export type AgentStatus = { installed: boolean; loggedIn: boolean | null; detail: string };

export interface AgentAdapter {
  id: string;
  label: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  // The signal fires when the check has taken too long; the adapter kills its process then.
  probe?(signal?: AbortSignal): Promise<AgentStatus>;
}
