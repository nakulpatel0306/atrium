import { KIND } from "../../engine/words";
import { NotebookPen } from "lucide-react";
import { useState } from "react";
import type { MemoryFile, MemoryLine } from "../../engine/memory";
import { post, type State, useFetched } from "../api";

type Space = State["spaces"][number];
type Size = Omit<MemoryFile, "text"> | null;

// The repo's CLAUDE.md against its line budget; past it, a warning. Nothing for a space with no repo.
export function MemorySize({ space, version }: { space: Space; version: unknown }) {
  const size = useFetched<Size>(space.kind === "repo" ? `/api/spaces/${space.id}/memory` : null, version);
  if (!size) return null;
  if (size.problem) return <span className="hint">{size.problem}</span>;
  if (size.missing) return <span className="hint">No CLAUDE.md in this repo yet.</span>;
  const over = size.lines > size.budget;
  return (
    <span className={over ? "why bad" : "hint"}>
      CLAUDE.md: {size.lines} of {size.budget} lines{over ? ". Past the budget, agents read more and follow less; trim what's obvious from the code." : ""}
    </span>
  );
}

// One proposed line: the exact text, editable, accepted with one click into its own commit, or dismissed.
export function MemoryProposal({ line, space }: { line: MemoryLine; space: Space }) {
  const [text, setText] = useState(line.line);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (body: { action: "accept"; line: string } | { action: "dismiss" }) => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/memory/${line.id}`, body);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  return (
    <div className="memory">
      <p>
        <NotebookPen />
        Add a line to CLAUDE.md? <span className="hint">{line.why}</span>
      </p>
      <input aria-label="Line to add to CLAUDE.md" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />
      <div className="acts">
        <button className="btn p" disabled={busy || !text.trim()} onClick={() => void answer({ action: "accept", line: text })}>
          {KIND.memory.action}
        </button>
        <button className="btn" disabled={busy} onClick={() => void answer({ action: "dismiss" })}>
          Not this
        </button>
        <MemorySize space={space} version={line.id} />
      </div>
      <p className="hint">{line.taskId ? "Committed on the task's branch while it's open, or else on a branch of its own." : "Committed on a branch of its own."} Edit it first if it's not quite right.</p>
      {error && <p className="err">{error}</p>}
    </div>
  );
}
