// Tells the dashboard a running repo task's changes moved, so the Changes view refetches. At most one event per
// window per task; an edit inside the window is sent when it closes, so the last one is never lost.
const FILE_EDIT = /^→ (Edit|Write|MultiEdit|NotebookEdit)\b/;

export const isFileEdit = (chunk: string) => FILE_EDIT.test(chunk);

export function createDiffNotifier(emit: (taskId: string) => void, opts: { windowMs?: number; pollMs?: number } = {}) {
  const windowMs = opts.windowMs ?? 1500;
  const pollMs = opts.pollMs ?? 5000;
  const last = new Map<string, number>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function fire(taskId: string) {
    last.set(taskId, Date.now());
    emit(taskId);
  }

  function edited(taskId: string) {
    if (pending.has(taskId)) return;
    const wait = (last.get(taskId) ?? -Infinity) + windowMs - Date.now();
    if (wait <= 0) return fire(taskId);
    pending.set(
      taskId,
      setTimeout(() => {
        pending.delete(taskId);
        fire(taskId);
      }, wait),
    );
  }

  // For one run. An agent whose output doesn't say when it edits a file (Codex, Gemini) is checked on a timer
  // instead; the timer lives only as long as the run, so an idle engine still does no polling.
  function watch(taskId: string, poll: boolean): () => void {
    const timer = poll ? setInterval(() => edited(taskId), pollMs) : null;
    return () => {
      if (timer) clearInterval(timer);
      // An edit still waiting on the window is sent now, so the view ends on the run's last change.
      const waiting = pending.get(taskId);
      clearTimeout(waiting);
      pending.delete(taskId);
      last.delete(taskId);
      if (waiting) emit(taskId);
    };
  }

  return { edited, watch };
}
