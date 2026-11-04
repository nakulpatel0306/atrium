export interface AgentRunInput {
  prompt: string;
  cwd: string;
  systemPrompt: string;
  allowedTools: string[];
  onChunk(text: string): void;
  signal?: AbortSignal;
}

export type AgentRunResult =
  | { status: "ok"; summary: string; inputTokens: number; outputTokens: number }
  | {
      status: "error";
      kind: "not_installed" | "not_logged_in" | "rate_limited" | "failed";
      message: string;
      retryAfter?: number;
    };

export interface AgentAdapter {
  id: string;
  label: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
