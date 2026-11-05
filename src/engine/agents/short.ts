// One line for the live view: a tool call's command or path, whitespace collapsed and capped at 80 characters.
export function shortCommand(command: unknown): string {
  const s = String(command ?? "").replace(/\s+/g, " ");
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
