import { Trash2 } from "lucide-react";
import { useState } from "react";
import { del, type State, useFetched } from "../api";
import { type TaskDeletePreview, taskDeleteLine } from "../deletion";
import { showToast } from "../toast";

type Task = State["tasks"][number];

// A simple two-step confirm: the task's own runs, history and files are all that go.
export function DeleteTask({ task }: { task: Task }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useFetched<TaskDeletePreview>(asking ? `/api/tasks/${encodeURIComponent(task.id)}/delete-preview` : null, task.updatedAt);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = await del<{ title: string; kept: string[] }>(`/api/tasks/${encodeURIComponent(task.id)}`);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    showToast(`Deleted "${res.data.title}".`);
  };

  if (task.status === "running") return null;
  return (
    <div className="task-delete">
      {asking ? (
        <>
          <span className="hint">{preview ? (preview.refusal ?? taskDeleteLine(preview)) : "Checking what goes with it…"}</span>
          <button className="btn" onClick={() => setAsking(false)}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy || !preview || preview.refusal !== null} onClick={() => void remove()}>
            Delete task
          </button>
        </>
      ) : (
        <button className="btn link subtle" onClick={() => setAsking(true)}>
          <Trash2 />
          Delete task…
        </button>
      )}
      {error && <span className="err">{error}</span>}
    </div>
  );
}
