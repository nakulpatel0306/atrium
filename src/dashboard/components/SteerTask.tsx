import { Send } from "lucide-react";
import { useEffect, useReducer } from "react";
import type { PostResult } from "../api";
import { post, type State } from "../api";

type Task = State["tasks"][number];

// `restarting` lasts from a sent note until the task runs again; `left` says it has stopped running in between, so
// the old run still winding down isn't mistaken for the new one.
export type SteerState = { note: string; busy: boolean; restarting: boolean; left: boolean; error: string | null };
export type SteerEvent =
  | { type: "edit"; note: string }
  | { type: "sending" }
  | { type: "sent"; status: Task["status"] }
  | { type: "failed"; error: string }
  | { type: "status"; status: Task["status"] };

export const STEER_START: SteerState = { note: "", busy: false, restarting: false, left: false, error: null };

export function steerReducer(s: SteerState, e: SteerEvent): SteerState {
  switch (e.type) {
    case "edit":
      return { ...s, note: e.note, error: null };
    case "sending":
      return { ...s, busy: true, error: null };
    case "sent":
      return { ...STEER_START, restarting: true, left: e.status !== "running" };
    case "failed":
      return { ...s, busy: false, error: e.error };
    case "status":
      if (!s.restarting) return s;
      if (e.status !== "running") return e.status === "queued" ? (s.left ? s : { ...s, left: true }) : STEER_START;
      return s.left ? STEER_START : s;
  }
}

export async function requestSteer(task: Task, note: string, send: (path: string, body: unknown) => Promise<PostResult<Task>> = (p, b) => post<Task>(p, b)) {
  return send(`/api/tasks/${encodeURIComponent(task.id)}/steer`, { note });
}

type ViewProps = { state: SteerState; onEdit: (note: string) => void; onSend: () => void };

// The form, without state, so a test can drive it.
export function SteerForm({ state, onEdit, onSend }: ViewProps) {
  if (state.restarting) return <p className="steer-wait">Restarting with your note…</p>;
  return (
    <form
      className="steer"
      onSubmit={(e) => {
        e.preventDefault();
        if (state.note.trim() && !state.busy) onSend();
      }}
    >
      <input
        value={state.note}
        maxLength={2000}
        disabled={state.busy}
        onChange={(e) => onEdit(e.target.value)}
        placeholder="Steer: tell it what to change…"
        aria-label="Note for the agent"
      />
      <button className="btn" type="submit" disabled={state.busy || !state.note.trim()} title="Stops the agent and starts it again on the same branch with your note">
        <Send />
        Send
      </button>
      {state.error && <span className="err">{state.error}</span>}
    </form>
  );
}

// Steering stops the run and starts it again with the note, so the agent keeps its edits but not its train of thought.
export function SteerTask({ task }: { task: Task }) {
  const [state, dispatch] = useReducer(steerReducer, STEER_START);
  useEffect(() => dispatch({ type: "status", status: task.status }), [task.status]);

  const send = async () => {
    dispatch({ type: "sending" });
    const res = await requestSteer(task, state.note.trim());
    dispatch(res.ok ? { type: "sent", status: res.data.status } : { type: "failed", error: res.error });
  };

  if (task.status !== "running" && !state.restarting) return null;
  return <SteerForm state={state} onEdit={(note) => dispatch({ type: "edit", note })} onSend={() => void send()} />;
}
