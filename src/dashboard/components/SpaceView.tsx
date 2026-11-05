import { CornerDownRight, Lock, Play, SearchCheck, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AgentChoice, agentName, agentText, byPriority, needsAction, ranAgent, type Wait, waitOf } from "../agents";
import { patch, post, type State, useReviewers, useRunOutput } from "../api";
import { absolute, duration, relative, tokens } from "../format";
import { navigate } from "../route";
import { Activity } from "./Activity";
import { AgentPicker } from "./AgentPicker";
import { Avatar } from "./Avatar";
import { StatusIcon } from "./StatusIcon";
import { Thread } from "./Thread";
import { Transcript } from "./Transcript";
import { WaitLine } from "./WaitLine";
import { MarketsPanel } from "./markets/MarketsPanel";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Run = State["runs"][number];

const STATUS_TEXT: Record<Task["status"], string> = {
  queued: "queued",
  running: "running",
  review: "in review",
  done: "done",
  failed: "failed",
  blocked: "blocked",
};

const REVIEWER_CHOICES = ["none", "codex", "gemini", "claude"] as const;

const KIND: Record<Exclude<Task["kind"], "work">, { label: string; icon: typeof SearchCheck; prefix: string }> = {
  review: { label: "Review", icon: SearchCheck, prefix: "Review: " },
  fix: { label: "Fix", icon: Wrench, prefix: "Fix: " },
};

// The engine titles child tasks "Review: …" and "Fix: …"; the badge says that, so the title needn't.
function shownTitle(task: Task): string {
  if (task.kind === "work") return task.title;
  const { prefix } = KIND[task.kind];
  return task.title.startsWith(prefix) ? task.title.slice(prefix.length) : task.title;
}

function KindBadge({ kind }: { kind: Task["kind"] }) {
  if (kind === "work") return null;
  const { label, icon: Icon } = KIND[kind];
  return (
    <span className={`tag kind ${kind}`}>
      <Icon />
      {label}
    </span>
  );
}

function reviewHint(reviewBy: Space["reviewBy"]): string {
  if (!reviewBy) return "A second agent can read each finished change before you approve it.";
  // The engine skips the review when the reviewer is the agent that did the work.
  return `${agentName(reviewBy)} reads each finished change it didn't make and can ask for one round of fixes. You still decide.`;
}

function ReviewSetting({ space }: { space: Space }) {
  const reasons = useReviewers(space);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = space.reviewBy ? reasons?.[space.reviewBy] : null;

  const choose = async (value: (typeof REVIEWER_CHOICES)[number]) => {
    setBusy(true);
    setError(null);
    const res = await patch<Space>(`/api/spaces/${space.id}`, { reviewBy: value === "none" ? null : value });
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  return (
    <div className="review-setting">
      <label>
        <SearchCheck />
        Review finished work with
        <select
          className="pick"
          value={space.reviewBy ?? "none"}
          disabled={busy}
          onChange={(e) => void choose(e.target.value as (typeof REVIEWER_CHOICES)[number])}
        >
          {REVIEWER_CHOICES.map((id) => (
            <option key={id} value={id}>
              {id === "none" ? "No one" : agentName(id)}
              {id !== "none" && reasons?.[id] ? " (can't work here)" : ""}
            </option>
          ))}
        </select>
      </label>
      {reason ? (
        <span className="why bad">{reason} Reviews will be skipped until you pick another reviewer.</span>
      ) : (
        <span className="hint">{reviewHint(space.reviewBy)}</span>
      )}
      {error && <span className="err">{error}</span>}
    </div>
  );
}

function Header({ space }: { space: Space }) {
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(space.goal);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (body: Partial<Pick<Space, "goal" | "private" | "status">>) => {
    setBusy(true);
    setError(null);
    const res = await patch<Space>(`/api/spaces/${space.id}`, body);
    setBusy(false);
    if (!res.ok) setError(res.error);
    return res.ok;
  };

  const saveGoal = async () => {
    const value = goal.trim();
    if (!value) return setError("A goal can't be empty. Describe what this space is for.");
    if (value === space.goal || (await save({ goal: value }))) setEditing(false);
  };

  const archive = async () => {
    // Archived spaces leave the sidebar, so there's nothing left to show here.
    if (await save({ status: "archived" })) navigate("/");
  };

  return (
    <div className="space-head">
      <div className="title-row">
        <span className="sd" style={{ background: space.color }} />
        <h1>{space.name}</h1>
        <span className="tag">{space.kind}</span>
        {space.repoPath && (
          <span className="tag mono path" title={space.repoPath}>
            {space.repoPath}
          </span>
        )}
        <div className="head-acts">
          <div className="private">
            <button
              className="toggle"
              role="switch"
              aria-checked={space.private || space.kind === "markets"}
              disabled={busy || space.kind === "markets"}
              onClick={() => void save({ private: !space.private })}
            >
              <span className="switch" />
              <Lock />
              Private
            </button>
            <span className="hint">
              {space.kind === "markets" ? "Markets spaces stay private: your holdings only go to Claude." : "Private spaces only use Claude"}
            </span>
          </div>
          {confirmArchive ? (
            <>
              <span className="hint">Archive this space? Its agents stop picking up tasks.</span>
              <button className="btn" onClick={() => setConfirmArchive(false)}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void archive()}>
                Archive
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setConfirmArchive(true)}>
              Archive
            </button>
          )}
        </div>
      </div>
      {editing ? (
        <form
          className="goal-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void saveGoal();
          }}
        >
          <input
            autoFocus
            value={goal}
            aria-label="Goal"
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setGoal(space.goal);
              setEditing(false);
              setError(null);
            }}
          />
          <button className="btn p" type="submit" disabled={busy}>
            Save
          </button>
        </form>
      ) : (
        <button
          className="brief goal"
          title="Edit goal"
          onClick={() => {
            setGoal(space.goal);
            setEditing(true);
          }}
        >
          {space.goal || "Add a goal for this space"}
        </button>
      )}
      {error && <div className="err">{error}</div>}
      {/* Reviews read the branch diff, so only repo spaces have anything to review. */}
      {space.kind === "repo" && <ReviewSetting space={space} />}
    </div>
  );
}

function RunRow({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const outcome = run.endedAt === null ? "running" : run.exitCode === 0 ? "finished" : "ended without finishing";
  return (
    <li>
      <span title={absolute(run.startedAt)}>
        {new Date(run.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
      </span>
      <span>
        {outcome}
        {run.endedAt !== null && ` after ${duration(run.endedAt - run.startedAt)}`}
      </span>
      <span>
        {tokens(run.inputTokens)} in · {tokens(run.outputTokens)} out
      </span>
      <a
        href={`/api/runs/${run.id}/transcript`}
        onClick={(e) => {
          e.preventDefault();
          onOpen();
        }}
      >
        View transcript
      </a>
    </li>
  );
}

type TaskRowProps = {
  task: Task;
  state: State;
  open: boolean;
  onToggle: () => void;
  onTranscript: (run: Run) => void;
};

function TaskRow({ task, state, open, onToggle, onTranscript }: TaskRowProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stuck = task.status === "blocked" || task.status === "failed";
  const runs = state.runs.filter((r) => r.taskId === task.id);
  const wait = waitOf(task, state);
  const parent = task.parentTaskId ? state.tasks.find((t) => t.id === task.parentTaskId) : undefined;
  const agent = agentText(task, state.runs);

  const act = async (fn: () => ReturnType<typeof post>) => {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  const retry = () => act(() => post(`/api/tasks/${task.id}/retry`));
  const runNow = () => act(() => post(`/api/tasks/${task.id}/run-now`));
  const setAgent = (value: AgentChoice) => act(() => patch(`/api/tasks/${task.id}`, { agent: value }));

  return (
    <div className="entry" id={`task-${task.id}`}>
      <div className={`item task${task.status === "done" ? " done" : ""}`} onClick={onToggle} aria-expanded={open}>
        <StatusIcon status={task.status} />
        <KindBadge kind={task.kind} />
        <span className="t">{shownTitle(task)}</span>
        {wait ? (
          <span className={`tag ${needsAction(wait) ? "bad" : "wait"}`} title={wait.reason}>
            waiting
          </span>
        ) : (
          <span className={`tag${stuck ? " bad" : ""}`} title={task.blockedReason ?? undefined}>
            {STATUS_TEXT[task.status]}
            {task.status === "blocked" && task.blockedReason && `: ${task.blockedReason}`}
          </span>
        )}
        {stuck && (
          <button
            className="btn"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void retry();
            }}
          >
            Retry
          </button>
        )}
        {wait?.kind === "reserve" && (
          <button
            className="btn"
            disabled={busy}
            title="Start this task now, using Claude's reserved window"
            onClick={(e) => {
              e.stopPropagation();
              void runNow();
            }}
          >
            <Play />
            Run now
          </button>
        )}
        <Avatar agent={ranAgent(task, state.runs)} live={task.status === "running"} title={agent} />
      </div>
      {open && (
        <div className="detail">
          {task.status === "blocked" && task.blockedReason && <p className="err reason">{task.blockedReason}</p>}
          {wait && <WaitLine wait={wait} />}
          {parent && (
            <p className="follows">
              <CornerDownRight />
              {task.kind === "review" ? "Reviews" : "Fixes what the review found in"} “{parent.title}”
            </p>
          )}
          <pre>{task.detail || task.title}</pre>
          <div className="meta">
            <span className="agent-meta">
              Agent
              {task.status === "queued" && task.kind === "work" ? (
                <AgentPicker value={task.agent} disabled={busy} onChange={(v) => void setAgent(v)} label="Agent for this task" />
              ) : (
                <b>{agent}</b>
              )}
            </span>
            <span title={absolute(task.createdAt)}>Added {relative(task.createdAt)}</span>
            <span title={absolute(task.updatedAt)}>Updated {relative(task.updatedAt)}</span>
            {task.branch && <span className="mono">Branch {task.branch}</span>}
            <span>{task.weight === "heavy" ? "Heavy · runs when plugged in" : "Light · runs anytime"}</span>
            {task.ignoreReserve && <span>Runs during Claude's reserve</span>}
          </div>
          {task.kind === "work" && <Thread taskId={task.id} />}
          {runs.length === 0 ? (
            <p className="runs-empty">No runs yet.</p>
          ) : (
            <ul className="runs">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} onOpen={() => onTranscript(r)} />
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

function Terminal({ runId }: { runId: string }) {
  const output = useRunOutput(runId);
  const ref = useRef<HTMLPreElement>(null);
  // Follows new output until the user scrolls up to read, then resumes once they scroll back down.
  const stick = useRef(true);

  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [output]);

  return (
    <pre
      ref={ref}
      className="term mono"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {output || <span className="p">Waiting for the agent's first words…</span>}
    </pre>
  );
}

function Live({ state, tasks }: { state: State; tasks: Task[] }) {
  const task = tasks.find((t) => t.status === "running");
  const run = task && state.runs.find((r) => r.taskId === task.id && r.endedAt === null);

  if (!task || !run) {
    // One line per distinct reason, so three tasks held by the same limit don't repeat it.
    const waits = new Map<string, Wait>();
    for (const wait of tasks.flatMap((t) => waitOf(t, state) ?? []).sort(byPriority)) {
      if (!waits.has(wait.reason)) waits.set(wait.reason, wait);
    }
    return (
      <div className="idle">
        <p>No agent working right now</p>
        {[...waits.values()].map((w) => (
          <WaitLine key={w.reason} wait={w} />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="agentrow">
        <Avatar agent={run.agent} live />
        {agentText(task, state.runs)}
        <span className="st" title={`Started ${absolute(run.startedAt)}`}>
          running {duration(Date.now() - run.startedAt)}
        </span>
      </div>
      <div className="agent-task">
        <KindBadge kind={task.kind} /> {shownTitle(task)}
      </div>
      <Terminal runId={run.id} />
    </>
  );
}

const ORDER: Task["status"][] = ["running", "blocked", "failed", "review", "queued"];

type Props = {
  state: State;
  space: Space | undefined;
  // Task to open expanded, from a `?task=` link such as Needs you's "View transcript".
  focusTask: string | null;
};

export function SpaceView({ state, space, focusTask }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusTask ? [focusTask] : []));
  const [transcript, setTranscript] = useState<{ run: Run; title: string } | null>(null);
  const [, setTick] = useState(0);
  const tasks = space ? state.tasks.filter((t) => t.spaceId === space.id) : [];
  const running = tasks.some((t) => t.status === "running");

  useEffect(() => {
    if (!focusTask) return;
    setExpanded((prev) => new Set(prev).add(focusTask));
    document.getElementById(`task-${focusTask}`)?.scrollIntoView({ block: "center" });
  }, [focusTask]);

  // Keeps "running 12m" ticking; only while something runs, so an idle page does no work.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [running]);

  if (!space) {
    return (
      <div className="wrap">
        <h1>Space not found</h1>
        <p className="brief">It may have been archived. Pick another space from the sidebar.</p>
      </div>
    );
  }

  // Open work in queue order, finished work newest first underneath.
  const open = ORDER.flatMap((s) => tasks.filter((t) => t.status === s));
  const done = tasks.filter((t) => t.status === "done").reverse();
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="wrap">
      <Header key={space.id} space={space} />
      {space.kind === "markets" && <MarketsPanel spaceId={space.id} />}
      <div className="cols">
        <div>
          <h2>Tasks</h2>
          <div className="list">
            {tasks.length === 0 ? (
              <div className="empty-row">No tasks yet. Give {space.name} one in the bar below.</div>
            ) : (
              [...open, ...done].map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  state={state}
                  open={expanded.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onTranscript={(run) => setTranscript({ run, title: t.title })}
                />
              ))
            )}
          </div>
          <Activity state={state} spaceId={space.id} />
        </div>
        <div className="live">
          <h2>Live</h2>
          <Live state={state} tasks={tasks} />
        </div>
      </div>
      {transcript && (
        <Transcript runId={transcript.run.id} title={transcript.title} onClose={() => setTranscript(null)} />
      )}
    </div>
  );
}
