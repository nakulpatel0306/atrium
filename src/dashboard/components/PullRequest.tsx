import { ExternalLink, GitPullRequest } from "lucide-react";
import { useEffect, useReducer } from "react";
import type { PrInfo } from "../../engine/repos/pr";
import { post, type PostResult, type State, useFetched } from "../api";

type Task = State["tasks"][number];
type Eligible = Extract<PrInfo, { eligible: true }>;

export type PrState = { asking: boolean; title: string; body: string; busy: boolean; error: string | null; url: string | null };
export type PrEvent =
  | { type: "ask"; title: string; body: string }
  | { type: "cancel" }
  | { type: "edit"; title?: string; body?: string }
  | { type: "sending" }
  | { type: "done"; url: string }
  | { type: "failed"; error: string };

export const PR_START: PrState = { asking: false, title: "", body: "", busy: false, error: null, url: null };

export function prReducer(s: PrState, e: PrEvent): PrState {
  switch (e.type) {
    case "ask":
      return { ...s, asking: true, title: e.title, body: e.body, error: null };
    case "cancel":
      return { ...s, asking: false, error: null };
    case "edit":
      return { ...s, title: e.title ?? s.title, body: e.body ?? s.body };
    case "sending":
      return { ...s, busy: true, error: null };
    case "done":
      return { ...PR_START, url: e.url };
    case "failed":
      return { ...s, busy: false, error: e.error };
  }
}

// `sha` is the commit the confirm step showed, so what's pushed is exactly what was on screen.
export const requestPr = (
  taskId: string,
  pr: { title: string; body: string; sha: string },
  send: (path: string, body: unknown) => Promise<PostResult<{ url: string }>> = (p, b) => post<{ url: string }>(p, b),
) => send(`/api/tasks/${encodeURIComponent(taskId)}/pr`, pr);

// An external link: the Mac app hands target=_blank links off the dashboard to the default browser.
export function PrLink({ url }: { url: string }) {
  return (
    <p className="pr-done">
      <GitPullRequest />
      Pull request opened ·{" "}
      <a href={url} target="_blank" rel="noopener noreferrer">
        View on GitHub
        <ExternalLink />
      </a>
    </p>
  );
}

type ViewProps = { info: Eligible; state: PrState; onAsk: () => void; onCancel: () => void; onEdit: (e: { title?: string; body?: string }) => void; onSubmit: () => void };

// The button and its confirm step, without state, so a test can drive them. The submit is the user's yes to the push.
export function PrForm({ info, state, onAsk, onCancel, onEdit, onSubmit }: ViewProps) {
  if (!state.asking) {
    return (
      <div className="pr">
        <button className="btn" onClick={onAsk}>
          <GitPullRequest />
          Open pull request
        </button>
      </div>
    );
  }
  return (
    <form
      className="pr pr-confirm"
      onSubmit={(e) => {
        e.preventDefault();
        if (state.title.trim() && !state.busy) onSubmit();
      }}
    >
      <dl className="pr-facts">
        <dt>Branch</dt>
        <dd className="mono">
          {info.branch} at {info.sha.slice(0, 7)}
        </dd>
        <dt>Into</dt>
        <dd className="mono">{info.base}</dd>
        <dt>Repo</dt>
        <dd className="mono">{info.repo}</dd>
      </dl>
      <label>
        Title
        <input value={state.title} maxLength={256} disabled={state.busy} onChange={(e) => onEdit({ title: e.target.value })} />
      </label>
      <label>
        Description
        <textarea value={state.body} rows={5} disabled={state.busy} onChange={(e) => onEdit({ body: e.target.value })} />
      </label>
      <p className="hint">Atrium pushes {info.branch} to GitHub as you, then opens the pull request. Nothing is merged.</p>
      <div className="pr-acts">
        <button className="btn" type="button" disabled={state.busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn p" type="submit" disabled={state.busy || !state.title.trim()}>
          {state.busy ? "Pushing…" : "Push and open PR"}
        </button>
      </div>
      {state.error && <p className="err">{state.error}</p>}
    </form>
  );
}

export function PullRequest({ task }: { task: Task }) {
  const info = useFetched<PrInfo>(`/api/tasks/${encodeURIComponent(task.id)}/pr`, `${task.status}:${task.updatedAt}`);
  const [state, dispatch] = useReducer(prReducer, PR_START);
  useEffect(() => {
    if (info?.url) dispatch({ type: "done", url: info.url });
  }, [info?.url]);

  const url = state.url ?? info?.url ?? null;
  if (url) return <PrLink url={url} />;
  if (!info?.eligible) return null;
  const submit = async () => {
    dispatch({ type: "sending" });
    const res = await requestPr(task.id, { title: state.title.trim(), body: state.body, sha: info.sha });
    dispatch(res.ok ? { type: "done", url: res.data.url } : { type: "failed", error: res.error });
  };
  return (
    <PrForm
      info={info}
      state={state}
      onAsk={() => dispatch({ type: "ask", title: info.title, body: info.body })}
      onCancel={() => dispatch({ type: "cancel" })}
      onEdit={(e) => dispatch({ type: "edit", ...e })}
      onSubmit={() => void submit()}
    />
  );
}
