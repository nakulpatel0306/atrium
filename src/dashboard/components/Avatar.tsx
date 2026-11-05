import { agentName } from "../agents";

// Codex takes X so it doesn't share Claude's C.
const LETTERS: Record<string, string> = { claude: "C", codex: "X", gemini: "G", auto: "A" };

export function Avatar({ agent, live = false, title }: { agent: string; live?: boolean; title?: string }) {
  return (
    <span className={`av c-${LETTERS[agent] ? agent : "other"}${live ? " live" : ""}`} title={title ?? agentName(agent)}>
      {LETTERS[agent] ?? agent.charAt(0).toUpperCase()}
    </span>
  );
}
