import { asksBeforeStarting, attentionQueue } from "../../engine/needs";
import { KIND as QUEUE_KIND, taskLabel, taskWord } from "../../engine/words";
import { CornerDownRight, GraduationCap, Lock, Play, SearchCheck, SlidersHorizontal, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AgentChoice, agentName, agentText, needsAction, ranAgent, waitOf } from "../agents";
import { patch, post, type State, useReviewers, useRunOutput } from "../api";
import { absolute, duration, relative, tokens } from "../format";
import { plainStop } from "../../engine/text";
import { type ChangeSpot, navigate, type SpaceTab } from "../route";
import { useSpaceFiles } from "../files";
import { distinctWaits, liveRun, orderedTasks, reviewerName, reviewHint, reviewLine, runOutcome, shownTitle, STATUS_TEXT } from "../summary";
import { isRisky, resultWord } from "../queue";
import { type Learning, LEARNING_LEVELS, REVIEW_CHOICES } from "../../engine/spaces";
import { MemorySize } from "./Memory";
import { RetroCard, RollupCard } from "./Retro";
import { ChecksBadge, LoopPanel } from "./LoopPanel";
import { CostChip } from "./Shape";
import { followsText } from "../../engine/shape";
import { spendText } from "../../engine/cost";
import { compact } from "../../engine/loop";
import { kindLabel, setArchived } from "../spaces";
import { Activity, TaskHistory, taskGroups } from "./Activity";
import { ResultDecision } from "./ResultDecision";
import { ARM_MS, armLabel } from "./Decision";
import { KeysSheet } from "./KeysSheet";
import { ACT, DECISION_KEYS, needsKey, NOTHING_FOR, PAGE_KEY_HELP, PAGE_KEY_NOTE, SHEET_OPEN } from "../needs-keys";
import { pressable } from "../page-keys";
import { announce } from "../live";
import { undoLatest } from "../toast";
import { DeleteSpace } from "./DeleteSpace";
import { DeleteTask } from "./DeleteTask";
import { StopTask } from "./StopTask";
import { AgentPicker } from "./AgentPicker";
import { FilesTab } from "./FilesTab";
import { Markdown } from "./Markdown";
import { SpaceNeeds } from "./NeedsYou";
import { Avatar } from "./Avatar";
import { StatusIcon } from "./StatusIcon";
import { OutcomeBanner } from "./OutcomeBanner";
import { outcomeLabel } from "../../engine/outcome";
import { STAYS_PRIVATE } from "../../engine/legacy";
import { Thread } from "./Thread";
import { Transcript } from "./Transcript";
import { WaitLine } from "./WaitLine";
import { BriefQuestions } from "./BriefQuestions";
import { RepoWork } from "./RepoWork";
import { WhatItMade } from "./WhatItMade";
import { TaskAttachments } from "./TaskAttachments";
import { withoutBlock } from "../../engine/attachment-rules";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Run = State["runs"][number];

const KIND: Record<Exclude<Task["kind"], "work">, { label: string; icon: typeof SearchCheck }> = {
  review: { label: "Review", icon: SearchCheck },
  fix: { label: "Fix", icon: Wrench },
};

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

const LEARNING_LABEL: Record<Learning, string> = { off: "Off", light: "Light", deep: "Deep" };
const LEARNING_HINT: Record<Learning, string> = {
  off: "No walkthroughs, retros, weekly roll-ups or CLAUDE.md suggestions.",
  light: "A walkthrough with each result, a retro once you accept it or open its pull request, a weekly roll-up and CLAUDE.md suggestions.",
  deep: "Light, plus a question before each walkthrough and the writer explaining its approach first.",
};

// Who reviews, what the gate runs, how much a task may spend before it pauses, and how much the space helps you learn
// from the code; every field has a default.
function LoopSettings({ space }: { space: Space }) {
  const reasons = useReviewers(space);
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState(space.checks ?? "");
  const [tokens, setTokens] = useState(space.budget ? String(space.budget.tokens) : "");
  const [minutes, setMinutes] = useState(space.budget ? String(space.budget.minutes) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = space.reviewBy !== "auto" && space.reviewBy !== "off" ? reasons?.[space.reviewBy] : null;

  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const res = await patch<Space>(`/api/spaces/${space.id}`, body);
    setBusy(false);
    if (!res.ok) setError(res.error);
    return res.ok;
  };

  return (
    <div className="review-setting">
      <label>
        <SearchCheck />
        Review with
        <select className="pick" value={space.reviewBy} disabled={busy} onChange={(e) => void save({ reviewBy: e.target.value })}>
          {REVIEW_CHOICES.map((id) => (
            <option key={id} value={id}>
              {reviewerName(id)}
              {id !== "auto" && id !== "off" && reasons?.[id] ? " (can't work here)" : ""}
            </option>
          ))}
        </select>
      </label>
      {reason ? <span className="why bad">{reason} Reviews will be skipped until you pick another reviewer.</span> : <span className="hint">{reviewHint(space.reviewBy)}</span>}
      <label>
        <GraduationCap />
        Learning
        <select className="pick" value={space.learning} disabled={busy} onChange={(e) => void save({ learning: e.target.value })}>
          {LEARNING_LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEARNING_LABEL[l]}
            </option>
          ))}
        </select>
      </label>
      <span className="hint">{LEARNING_HINT[space.learning]}</span>
      <MemorySize space={space} version={space.updatedAt} />
      <button className="btn link subtle" aria-expanded={open} onClick={() => setOpen(!open)}>
        Checks and budget
      </button>
      {open && (
        <form
          className="loop-settings"
          onSubmit={(e) => {
            e.preventDefault();
            const budget = tokens.trim() || minutes.trim() ? { tokens: Number(tokens), minutes: Number(minutes) } : null;
            void save({ checks: checks.trim() || null, budget }).then((ok) => ok && setOpen(false));
          }}
        >
          <label>
            Check commands <span className="hint">one per line, the last is the full test run; leave empty to use what Atrium finds</span>
            <textarea className="mono" rows={2} value={checks} onChange={(e) => setChecks(e.target.value)} />
          </label>
          <label>
            Budget per task <span className="hint">empty uses the defaults by task size</span>
            <span className="budget-fields">
              <input aria-label="Tokens per task" inputMode="numeric" placeholder="600000" value={tokens} onChange={(e) => setTokens(e.target.value)} />
              tokens
              <input aria-label="Minutes per task" inputMode="numeric" placeholder="45" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
              min
            </span>
          </label>
          <button className="btn p" type="submit" disabled={busy}>
            Save
          </button>
        </form>
      )}
      {error && <span className="err">{error}</span>}
    </div>
  );
}

function Header({ space, spend }: { space: Space; spend: State["spend"]["spaces"][string] | undefined }) {
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(space.goal);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // How the space runs (path, review, learning, checks, archive) stays folded so the work comes first.
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (body: Partial<Pick<Space, "goal" | "private">>) => {
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
    setBusy(true);
    setError(null);
    const res = await setArchived(space, true);
    setBusy(false);
    // Archived spaces leave the sidebar, so there's nothing left to show here.
    if (res.ok) navigate("/");
    else setError(res.error ?? null);
  };

  return (
    <div className="space-head">
      <div className="title-row">
        <span className="sd" style={{ background: space.color }} />
        <h1>{space.name}</h1>
        {kindLabel(space.kind) && <span className="tag">{kindLabel(space.kind)}</span>}
        {spend && (
          <span className="tag cost" title={`Weighted tokens, with an estimate at Anthropic's list prices. A subscription doesn't bill per token. This week: ${compact(spend.week.weighted)} · ${spendText(spend.week)}.`}>
            today {compact(spend.today.weighted)} · {spendText(spend.today)}
          </span>
        )}
        <div className="head-acts">
          <div className="private">
            <button
              className="toggle"
              role="switch"
              aria-checked={space.private}
              disabled={busy || space.unknownKind}
              onClick={() => void save({ private: !space.private })}
            >
              <span className="switch" />
              <Lock />
              Private
            </button>
            <span className="hint">{space.unknownKind ? STAYS_PRIVATE : "Private spaces only use Claude"}</span>
          </div>
          <button className="btn" aria-expanded={settings} aria-controls={`settings-${space.id}`} onClick={() => setSettings(!settings)}>
            <SlidersHorizontal />
            Settings
          </button>
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
      {settings && (
        <div className="space-settings" id={`settings-${space.id}`}>
          {space.repoPath && (
            <p className="hint">
              Repo <span className="mono">{space.repoPath}</span>
            </p>
          )}
          {/* Checks and reviews read the branch, so only repo spaces have them. */}
          {space.kind === "repo" && <LoopSettings space={space} />}
          <div className="acts">
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
              <>
                <button className="btn" onClick={() => setConfirmArchive(true)}>
                  Archive
                </button>
                <button className="btn" onClick={() => setDeleting(true)}>
                  Delete…
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {deleting && <DeleteSpace space={space} onClose={() => setDeleting(false)} onDeleted={() => navigate("/")} />}
    </div>
  );
}

function RunRow({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const outcome = runOutcome(run);
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
  // Open on its Changes, from a "See changes" link, at one hunk from a walkthrough's link.
  showChanges?: boolean;
  at?: ChangeSpot | null;
  // The first a on this task's risky result has been pressed; a second approves it.
  armed?: boolean;
};

// The queue kind a task waits under when that isn't already its state word: a question, a pick, a stopped part.
function queueKindOf(state: State, taskId: string) {
  const item = attentionQueue(state).find((i) => i.key === taskId);
  return item && (item.kind === "question" || item.kind === "pick" || item.kind === "stuck") ? item.kind : null;
}

function TaskRow({ task, state, open, onToggle, onTranscript, showChanges, at = null, armed = false }: TaskRowProps) {
  const [busy, setBusy] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const word = taskWord(task);
  // A task in the queue for something other than its state (a question before it starts, a pick) wears that kind.
  const asks = queueKindOf(state, task.id);
  const waitsOnYou = word === "paused" || word === "review";
  const stuck = word === "stopped" || word === "failed";
  const runs = state.runs.filter((r) => r.taskId === task.id);
  const wait = waitOf(task, state);
  const parent = task.parentTaskId ? state.tasks.find((t) => t.id === task.parentTaskId) : undefined;
  const agent = agentText(task, state.runs);
  const space = state.spaces.find((s) => s.id === task.spaceId);
  // A finished task the agent said it couldn't or only partly do is labelled that way, never plain done.
  const notDone = task.status === "done" && task.outcome ? outcomeLabel(task.outcome) : null;
  const review = task.status === "review" ? state.approvals.find((a) => a.taskId === task.id && a.kind === "review") : undefined;
  const risky = !!review && isRisky(state, review);
  // A result that went through the loop wears its verdict instead of "Ready for review", as in the queue and on Home.
  const verdict = review ? resultWord(state, review) : null;
  const attached = state.attachments.filter((a) => a.taskId === task.id);

  const act = async (fn: () => ReturnType<typeof post>) => {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  const retry = () => act(() => post(`/api/tasks/${task.id}/retry`));
  const runNow = () => act(() => post(`/api/tasks/${wait?.taskId ?? task.id}/run-now`));
  const setAgent = (value: AgentChoice) => act(() => patch(`/api/tasks/${task.id}`, { agent: value }));

  return (
    // An open row is where the page's keys act (page-keys.ts): its own buttons, and only those that show.
    <div className="entry" id={`task-${task.id}`} data-decision={open ? task.id : undefined}>
      {/* The summary is the row's one button; its actions sit beside it, so no control is nested in another. */}
      <div className={`item task${task.status === "done" ? " done" : ""}`}>
        <button className="task-open" aria-expanded={open} onClick={onToggle}>
          {/* The tag beside it says the state in words; the icon is only for the eye. */}
          <span aria-hidden="true">
            <StatusIcon status={task.status} outcome={task.outcome} paused={word === "paused"} verdict={verdict} />
          </span>
          <KindBadge kind={task.kind} />
          <span className="t" title={shownTitle(task)}>
            {shownTitle(task)}
          </span>
          {wait && !asks ? (
            // Still queued: what holds it back is in the tooltip. Only a wait that needs you (a sign-in) is coloured.
            <span className={`tag${needsAction(wait) ? " bad" : ""}`} title={wait.reason}>
              {taskLabel("queued")}
            </span>
          ) : (
            // One word on the row (engine/words.ts); why it stopped or isn't done is in the tooltip and the detail.
            <span
              className={`tag${stuck ? " bad" : word === "paused" || risky ? " wait" : verdict ? " good" : ""}${notDone ? " notdone" : ""}`}
              title={(review && reviewLine(review, state)?.text) || ((task.blockedReason && plainStop(task.blockedReason)) ?? task.loop?.paused?.diagnosis ?? task.outcomeReason ?? undefined)}
            >
              {notDone ?? (asks ? QUEUE_KIND[asks].label : (verdict ?? taskLabel(word)))}
            </span>
          )}
        </button>
        {stuck && task.legacyPurpose === null && (
          <button className="btn" disabled={busy} onClick={() => void retry()}>
            Retry
          </button>
        )}
        {wait?.kind === "reserve" && (
          <button className="btn" disabled={busy} title="Start this task now, using Claude's reserved window" onClick={() => void runNow()}>
            <Play />
            Run now
          </button>
        )}
        {/* A result's verdict already speaks for its checks, and its decision shows them; the row doesn't say it twice. */}
        {space?.kind === "repo" && task.kind === "work" && !verdict && (
          <ChecksBadge
            task={task}
            onOpen={() => {
              setShowChecks(true);
              if (!open) onToggle();
            }}
          />
        )}
        <StopTask task={task} />
        <Avatar agent={ranAgent(task, state.runs)} live={task.status === "running"} title={agent} />
      </div>
      {open && (
        <div className="detail">
          {/* The open task's sections (the walkthrough, You asked, History) sit under its title. */}
          <h3 className="sr-only">{shownTitle(task)}</h3>
          {/* A pause waits for a hint and reads amber; a stopped task waits for a retry and reads red. */}
          {task.status === "blocked" && task.blockedReason && <p className={`reason ${word === "paused" ? "wait-text" : "err"}`}>{plainStop(task.blockedReason)}</p>}
          {review ? (
            // The same decision, with the same evidence, as its screen in Needs you.
            <div className="task-decision">
              <ResultDecision approval={review} task={task} space={space} state={state} at={at} armed={armed} keys />
            </div>
          ) : (
            <>
              {task.status === "done" && <OutcomeBanner outcome={task.outcome} reason={task.outcomeReason} />}
              <RetroCard task={task} state={state} />
            </>
          )}
          {wait && <WaitLine wait={wait} />}
          {parent && (
            <p className="follows">
              <CornerDownRight />
              {followsText(task)} "{parent.title}"
            </p>
          )}
          {!review && task.kind === "work" && (task.brief || (task.loop && (space?.kind === "repo" || task.loop.paused || task.loop.explanation))) && (
            <LoopPanel key={String(showChecks)} task={task} state={state} repo={space?.kind === "repo"} showChecks={showChecks} />
          )}
          <section className="asked">
            <h4>You asked</h4>
            <Markdown text={(attached.length ? withoutBlock(task.detail) : task.detail) || task.title} />
          </section>
          <TaskAttachments attachments={attached} />
          {space?.kind === "repo" ? (
            <RepoWork task={task} space={space} agent={agentName(ranAgent(task, state.runs))} initial={showChanges ? "changes" : undefined} at={at} decided={!!review} />
          ) : (
            space && !review && <WhatItMade taskId={task.id} spaceId={space.id} spaceKind={space.kind} noChanges={task.loop?.noChanges} />
          )}
          <MoreDetails folded={waitsOnYou}>
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
            <span>{task.weight === "heavy" ? "Runs when your Mac is plugged in" : "Runs anytime"}</span>
            {task.ignoreReserve && <span>Runs during Claude's reserve</span>}
            {task.kind === "work" && <CostChip spend={state.spend.tasks[task.id]} />}
          </div>
          {task.kind === "work" && <Thread taskId={task.id} />}
          <TaskHistory task={task} state={state} />
          {/* Only the newest runs reach the dashboard, so an older task can have history but no listed runs. */}
          {runs.length === 0 ? (
            task.status === "queued" && taskGroups(task, state).length === 0 && <p className="runs-empty">No runs yet.</p>
          ) : (
            <ul className="runs">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} onOpen={() => onTranscript(r)} />
              ))}
            </ul>
          )}
          <DeleteTask task={task} />
          </MoreDetails>
        </div>
      )}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

// A task waiting on you leads with the decision; who ran it, when, its history and runs fold under Details.
function MoreDetails({ folded, children }: { folded: boolean; children: React.ReactNode }) {
  if (!folded) return <>{children}</>;
  return (
    <details className="task-more">
      <summary>Details: agent, history, runs</summary>
      {children}
    </details>
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

// A brief's questions, answered from Live with the same form its task shows. The form shows in one place: the
// task's own row when it's open, else here, whether or not another agent is running.
function Asking({ tasks, open }: { tasks: Task[]; open: Set<string> }) {
  const asking = tasks.filter((t) => t.loop?.stage === "brief" && asksBeforeStarting(t) && !open.has(t.id));
  return (
    <>
      {asking.map((t) => (
        <div className="live-ask" key={t.id}>
          <p className="live-ask-title">{shownTitle(t)} asks before it starts:</p>
          <BriefQuestions task={t} />
        </div>
      ))}
    </>
  );
}

function Live({ state, tasks, open }: { state: State; tasks: Task[]; open: Set<string> }) {
  const live = liveRun(state, tasks);

  if (!live) {
    return (
      <div className="idle">
        <p>No agent working right now</p>
        <Asking tasks={tasks} open={open} />
        {distinctWaits(tasks, state)
          .filter((w) => w.kind !== "answers")
          .map((w) => (
            <WaitLine key={`${w.reason}:${w.taskId}`} wait={w} />
          ))}
      </div>
    );
  }

  const { task, run } = live;
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
      <Asking tasks={tasks} open={open} />
    </>
  );
}

type Props = {
  state: State;
  space: Space | undefined;
  // Task to open expanded, from a `?task=` link such as Needs you's "View transcript".
  focusTask: string | null;
  tab?: SpaceTab;
  // Open the focused task on its Changes, from `&view=changes`, at one hunk with `&file=`.
  changes?: boolean;
  at?: ChangeSpot | null;
};

// The Files count comes from the same listing the tab shows, so it's read whichever tab is open.
function Tabs({ space, tab }: { space: Space; tab: SpaceTab }) {
  const files = useSpaceFiles(space.id);
  const go = (t: SpaceTab) => navigate(`/space/${space.id}${t === "files" ? "?tab=files" : ""}`);
  return (
    <div className="tabs" role="tablist">
      <button role="tab" aria-selected={tab === "tasks"} className={tab === "tasks" ? "on" : ""} onClick={() => go("tasks")}>
        Tasks
      </button>
      <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "on" : ""} onClick={() => go("files")}>
        Files{files ? ` · ${files.files.length}` : ""}
      </button>
    </div>
  );
}

export function SpaceView({ state, space, focusTask, tab = "tasks", changes = false, at = null }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusTask ? [focusTask] : []));
  const [transcript, setTranscript] = useState<{ run: Run; title: string } | null>(null);
  const [help, setHelp] = useState(false);
  // The task whose risky Approve the a key has been pressed once for, as in Needs you.
  const [armed, setArmed] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const tasks = space ? state.tasks.filter((t) => t.spaceId === space.id) : [];
  const running = tasks.some((t) => t.status === "running");

  useEffect(() => {
    if (!focusTask) return;
    setExpanded((prev) => new Set(prev).add(focusTask));
    document.getElementById(`task-${focusTask}`)?.scrollIntoView({ block: "start" });
  }, [focusTask]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  // The decision keys, on whichever open task shows the button (page-keys.ts). Attached once; `live` carries the arm.
  const live = useRef(armed);
  live.current = armed;
  const helpOpen = useRef(help);
  helpOpen.current = help;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = needsKey(e);
      if (!key || document.querySelector('[aria-modal="true"]')) return;
      if (key === "help") return setHelp((h) => !h);
      if (key === "close") {
        if (live.current) announce("Cancelled. Approve takes two presses again.");
        setArmed(null);
        return setHelp(false);
      }
      // A sheet over the page may cover the button a key would press; it's closed first.
      if (helpOpen.current && DECISION_KEYS.includes(key)) return announce(SHEET_OPEN);
      if (key === "undo") return void undoLatest();
      const act = ACT[key];
      if (!act) return;
      const found = pressable([...document.querySelectorAll<HTMLElement>("[data-decision]")], act, document.activeElement);
      if ("many" in found) return announce("More than one open task could take that key. Click in the one you mean, then press it again.");
      if ("none" in found) return announce(NOTHING_FOR[key] ?? "");
      e.preventDefault();
      const id = found.scope.dataset.decision ?? null;
      if (key === "approve" && found.button.dataset.risky && live.current !== id) {
        setArmed(id);
        return announce(`${armLabel(found.button.dataset.word ?? "", "key")}.`);
      }
      setArmed(null);
      found.button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keeps "running 12m" ticking; only while something runs, so an idle page does no work.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [running]);

  if (!space) {
    return (
      <div className="wrap">
        <h1>This space isn't here</h1>
        <p className="brief">It may have been archived, or the link is old. Pick a space from the sidebar, or go back to Home.</p>
      </div>
    );
  }

  const toggle = (id: string) => {
    setArmed(null);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  return (
    <div className="wrap">
      <Header key={space.id} space={space} spend={state.spend.spaces[space.id]} />
      {help && <KeysSheet keys={PAGE_KEY_HELP} note={PAGE_KEY_NOTE} floating onClose={() => setHelp(false)} />}
      <SpaceNeeds state={state} spaceId={space.id} />
      <div className="cols">
        <div>
          <h2 className="sr-only">Tasks</h2>
          <Tabs space={space} tab={tab} />
          {tab === "files" ? (
            <FilesTab space={space} />
          ) : (
          <div className="list">
            {tasks.length === 0 ? (
              <div className="empty-row">No tasks yet. Give {space.name} one in the bar below.</div>
            ) : (
              orderedTasks(tasks).map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  state={state}
                  open={expanded.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onTranscript={(run) => setTranscript({ run, title: t.title })}
                  showChanges={changes && t.id === focusTask}
                  at={t.id === focusTask ? at : null}
                  armed={armed === t.id}
                />
              ))
            )}
          </div>
          )}
          <RollupCard state={state} spaceId={space.id} />
          <Activity state={state} spaceId={space.id} />
        </div>
        <div className="live">
          <h2>Live</h2>
          <Live state={state} tasks={tasks} open={expanded} />
        </div>
      </div>
      {transcript && (
        <Transcript runId={transcript.run.id} title={transcript.title} onClose={() => setTranscript(null)} />
      )}
    </div>
  );
}
