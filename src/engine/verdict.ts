// A reviewer's last line is `VERDICT: approve` or `VERDICT: changes`. The engine acts on it and the dashboard
// shows it, so both read it here. Imports nothing, so the dashboard can bundle it.
export function verdictOf(summary: string): "approve" | "changes" | null {
  // Agents often dress the line up as `code` or **bold**; the markers don't change the verdict.
  const last = summary.trim().split("\n").at(-1)!.trim().replace(/^[`*_\s]+|[`*_\s]+$/g, "");
  const m = last.match(/^VERDICT:\s*(approve|changes)\.?$/i);
  return m ? (m[1]!.toLowerCase() as "approve" | "changes") : null;
}
