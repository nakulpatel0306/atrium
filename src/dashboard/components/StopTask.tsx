import { Square } from "lucide-react";
import { useEffect, useReducer } from "react";
import type { PostResult } from "../api";
import { post, type State } from "../api";
import { showToast } from "../toast";

type Task = State["tasks"][number];

export type StopState = { asking: boolean; busy: boolean; error: string | null };
export type StopEvent = { type: "ask" } | { type: "cancel" } | { type: "sending" } | { type: "done"; error: string | null } | { type: "notRunning" };

export const STOP_START: StopState = { asking: false, busy: false, error: null };

// Two steps, like Delete task: stopping throws away the rest of the agent's run, though its edits are kept. The
// confirm closes once the task isn't running, so a retried task never comes back with it already open.
export function stopReducer(s: StopState, e: StopEvent): StopState {
  switch (e.type) {
    case "ask":
      return { ...s, asking: true, error: null };
    case "cancel":
      return { ...s, asking: false };
    case "sending":
      return { ...s, busy: true, error: null };
    case "done":
      return { asking: false, busy: false, error: e.error };
    case "notRunning":
      return s.asking || s.busy ? { ...s, asking: false, busy: false } : s;
  }
}

// What the engine's answer means: it says how the stop actually went.
export function stopOutcome(title: string, res: PostResult<Task>): { toast: string } | { error: string } {
  if (!res.ok) return { error: res.error };
  if (res.data.status === "blocked") return { toast: `Stopped "${title}". Retry it when you're ready.` };
  if (res.data.status === "running") return { toast: `Stopping "${title}": the agent hasn't exited yet. Atrium marks it stopped when it does.` };
  return { toast: `"${title}" finished before it could be stopped.` };
}

export async function requestStop(task: Task, send: (path: string) => Promise<PostResult<Task>> = (p) => post<Task>(p)) {
  return stopOutcome(task.title, await send(`/api/tasks/${encodeURIComponent(task.id)}/stop`));
}

type ViewProps = { state: StopState; onAsk: () => void; onCancel: () => void; onStop: () => void };

// The buttons, without state, so a test can press them.
export function StopButtons({ state, onAsk, onCancel, onStop }: ViewProps) {
  return (
    <span className="task-stop" onClick={(e) => e.stopPropagation()}>
      {state.asking ? (
        <>
          <span className="hint">Stop the agent now? Its edits so far are kept.</span>
          <button className="btn" disabled={state.busy} onClick={onCancel}>
            Keep running
          </button>
          <button className="btn danger" disabled={state.busy} onClick={onStop}>
            Stop
          </button>
        </>
      ) : (
        <button className="btn" title="Stop this task's agent now" onClick={onAsk}>
          <Square />
          Stop…
        </button>
      )}
      {state.error && <span className="err">{state.error}</span>}
    </span>
  );
}

export function StopTask({ task }: { task: Task }) {
  const [state, dispatch] = useReducer(stopReducer, STOP_START);
  useEffect(() => {
    if (task.status !== "running") dispatch({ type: "notRunning" });
  }, [task.status]);

  const stop = async () => {
    dispatch({ type: "sending" });
    const out = await requestStop(task);
    dispatch({ type: "done", error: "error" in out ? out.error : null });
    if ("toast" in out) showToast(out.toast);
  };

  if (task.status !== "running") return null;
  return <StopButtons state={state} onAsk={() => dispatch({ type: "ask" })} onCancel={() => dispatch({ type: "cancel" })} onStop={() => void stop()} />;
}
