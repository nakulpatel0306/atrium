import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { AGENT_IDS, agentName } from "../agents";
import { activateOnKey } from "../activate";
import { post, type State } from "../api";
import { absolute, clock, duration, tokens } from "../format";
import { navigate } from "../route";
import { AGENT_ROLES, agentStatus, runOutcome } from "../summary";
import { Avatar } from "./Avatar";
import { Plain } from "./WaitLine";

type Info = State["agents"][string];
type Run = State["runs"][number];

const RECENT_RUNS = 5;
const RESERVE_STEPS = [0.25, 0.5, 0.75];

// The reserve marker sits where Claude tasks start waiting, so the bar shows how close that is.
export function WindowBar({ state, compact = false }: { state: State; compact?: boolean }) {
  const w = state.claudeWindow;
  const reserve = state.usage.claudeReserve;
  const used = w ? Math.min(1, Math.max(0, w.utilization)) : 0;
  const label = w ? `${Math.round(used * 100)}% of Claude's five-hour window used` : "No window reading yet";
  return (
    <span className={`window-bar${compact ? " compact" : ""}`} role="img" aria-label={label} title={label}>
      <i className={w && used >= reserve ? "over" : ""} style={{ width: `${used * 100}%` }} />
      <b style={{ left: `${reserve * 100}%` }} />
    </span>
  );
}

function ClaudeWindow({ state }: { state: State }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = state.claudeWindow;
  const reserve = state.usage.claudeReserve;

  const choose = async (value: number) => {
    setBusy(true);
    setError(null);
    const res = await post("/api/settings", { claudeReserve: value });
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  return (
    <div className="window">
      <div className="window-head">
        <span>Five-hour window</span>
        <span className="val">
          {w ? `${Math.round(w.utilization * 100)}% used · resets ${clock(w.resetsAt)}` : "No reading yet"}
        </span>
      </div>
      <WindowBar state={state} />
      {!w && <p className="note-line">Claude reports its window after each run, so this fills in after Claude's next task.</p>}
      <div className="reserve">
        <span>Pause Claude tasks at</span>
        <div className="seg" role="group" aria-label="Pause Claude tasks at this much of the window used">
          {RESERVE_STEPS.map((step) => (
            <button key={step} aria-pressed={reserve === step} disabled={busy} onClick={() => void choose(step)}>
              {Math.round(step * 100)}%
            </button>
          ))}
        </div>
        <span>used, so the rest stays yours. "Run now" on a task skips this.</span>
      </div>
      {error && <div className="err">{error}</div>}
      <p className="note-line">Estimated from Claude's own limit reports; Atrium can't see your exact quota.</p>
    </div>
  );
}

function RecentRuns({ runs, state }: { runs: Run[]; state: State }) {
  if (runs.length === 0) return <p className="runs-empty">No runs yet.</p>;
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  return (
    <ul className="runs agent-runs">
      {runs.map((r) => {
        const task = tasks.get(r.taskId);
        const outcome = runOutcome(r);
        const href = task ? `/space/${task.spaceId}?task=${task.id}` : null;
        return (
          <li key={r.id}>
            <span title={absolute(r.startedAt)}>
              {new Date(r.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
            {href ? (
              <a
                href={href}
                className="task-link"
                onClick={(e) => {
                  e.preventDefault();
                  navigate(href);
                }}
              >
                {task!.title}
              </a>
            ) : (
              <span className="task-link">Task no longer listed</span>
            )}
            <span>
              {outcome}
              {r.endedAt !== null && ` after ${duration(r.endedAt - r.startedAt)}`}
            </span>
            <span>{tokens(r.inputTokens + r.outputTokens)} tokens</span>
          </li>
        );
      })}
    </ul>
  );
}

function AgentRow({ id, info, state, open, onToggle }: { id: string; info: Info; state: State; open: boolean; onToggle: () => void }) {
  const line = agentStatus(id, info, state);
  const runs = state.runs.filter((r) => r.agent === id).slice(0, RECENT_RUNS);
  return (
    <div className="entry">
      <div className="item agent" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(e) => activateOnKey(e, onToggle)}>
        <ChevronRight className={`chev${open ? " open" : ""}`} />
        <Avatar agent={id} live={state.runs.some((r) => r.agent === id && r.endedAt === null)} />
        <span className="name">{agentName(id)}</span>
        <span className={`t status${line.tone ? ` ${line.tone}` : ""}`}>
          <Plain text={line.text} />
        </span>
        {id === "claude" && <WindowBar state={state} compact />}
        <span className="val">{tokens(info.tokensToday)} tokens today</span>
      </div>
      {open && (
        <div className="detail">
          <p className="role">{AGENT_ROLES[id]}</p>
          <div className="meta">
            <span>
              Last check: <Plain text={info.detail || "not checked yet"} />
            </span>
            {info.limitedUntil && <span title={absolute(info.limitedUntil)}>Limit resets {clock(info.limitedUntil)}</span>}
          </div>
          {id === "claude" && <ClaudeWindow state={state} />}
          <h3>Recent runs</h3>
          <RecentRuns runs={runs} state={state} />
        </div>
      )}
    </div>
  );
}

export function Agents({ state }: { state: State }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["claude"]));
  const ids = AGENT_IDS.filter((id) => state.agents[id]);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="wrap">
      <h1>Agents</h1>
      <p className="brief">
        Who can take work right now. Auto sends work to Claude. While Claude's window is being saved, general tasks go to
        Codex or Gemini and repo work waits. Reviews go to the agent each space picks.
      </p>
      <div className="list">
        {ids.length === 0 ? (
          <div className="empty-row">No agents are set up in this engine.</div>
        ) : (
          ids.map((id) => (
            <AgentRow key={id} id={id} info={state.agents[id]!} state={state} open={expanded.has(id)} onToggle={() => toggle(id)} />
          ))
        )}
      </div>
    </div>
  );
}
