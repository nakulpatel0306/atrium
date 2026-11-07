import { Square } from "lucide-react";
import { useState } from "react";
import { post, type State } from "../api";
import { showToast } from "../toast";

type Task = State["tasks"][number];

// Two steps, like Delete task: stopping throws away the rest of the agent's run, though its edits are kept.
export function StopTask({ task }: { task: Task }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = async () => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/tasks/${encodeURIComponent(task.id)}/stop`);
    setBusy(false);
    setAsking(false);
    if (!res.ok) return setError(res.error);
    showToast(`Stopped "${task.title}". Retry it when you're ready.`);
  };

  if (task.status !== "running") return null;
  return (
    <span className="task-stop" onClick={(e) => e.stopPropagation()}>
      {asking ? (
        <>
          <span className="hint">Stop the agent now? Its edits so far are kept.</span>
          <button className="btn" disabled={busy} onClick={() => setAsking(false)}>
            Keep running
          </button>
          <button className="btn danger" disabled={busy} onClick={() => void stop()}>
            Stop
          </button>
        </>
      ) : (
        <button className="btn" title="Stop this task's agent now" onClick={() => setAsking(true)}>
          <Square />
          Stop…
        </button>
      )}
      {error && <span className="err">{error}</span>}
    </span>
  );
}
