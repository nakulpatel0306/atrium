import { ArrowDown, Plus } from "lucide-react";
import { agentText, byPriority, needsAction, ranAgent, type Wait, waitOf } from "../agents";
import type { State } from "../api";
import { relative } from "../format";
import { navigate } from "../route";
import { Activity } from "./Activity";
import { Avatar } from "./Avatar";
import { Logo } from "./Logo";
import { NeedsYou } from "./NeedsYou";
import { StatusIcon } from "./StatusIcon";
import { Plain, WAIT_ICONS } from "./WaitLine";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

const OPEN = new Set<Task["status"]>(["queued", "running", "review", "blocked", "failed"]);
const SHOWN_TASKS = 3;

type Status = { text: string; tone?: "blocked" | "waiting"; wait?: Wait };

// Every held-back task's wait, most pressing first.
const waitsOf = (tasks: Task[], state: State): Wait[] =>
  tasks.flatMap((t) => waitOf(t, state) ?? []).sort(byPriority);

function status(space: Space, tasks: Task[], state: State): Status {
  const running = tasks.find((t) => t.status === "running");
  if (running) return { text: `${agentText(running, state.runs)} running · ${running.title}` };
  const [wait] = waitsOf(tasks, state);
  if (wait) return { text: wait.reason, tone: needsAction(wait) ? "blocked" : "waiting", wait };
  const stuck = tasks.filter((t) => t.status === "blocked" || t.status === "failed");
  if (stuck.length === 1 && stuck[0]!.status === "blocked") {
    return { text: `Blocked: ${stuck[0]!.blockedReason ?? stuck[0]!.title}`, tone: "blocked" };
  }
  if (stuck.length > 0) return { text: `${stuck.length} need${stuck.length === 1 ? "s" : ""} attention`, tone: "blocked" };
  const review = tasks.filter((t) => t.status === "review").length;
  if (review > 0) return { text: `${review} ready for your review` };
  const queued = tasks.filter((t) => t.status === "queued").length;
  if (queued > 0) return { text: `${queued} ${queued === 1 ? "task" : "tasks"} queued` };
  const last = state.activity.find((a) => a.spaceId === space.id)?.createdAt ?? space.updatedAt;
  return { text: `Idle · last activity ${relative(last)}` };
}

function SpaceCard({ space, state }: { space: Space; state: State }) {
  const tasks = state.tasks.filter((t) => t.spaceId === space.id);
  const open = tasks.filter((t) => OPEN.has(t.status));
  const s = status(space, tasks, state);
  // Who actually worked here; an auto task that hasn't run yet shows as Auto.
  const agents = [...new Set(tasks.map((t) => ranAgent(t, state.runs)))];
  const live = new Set(tasks.filter((t) => t.status === "running").map((t) => ranAgent(t, state.runs)));
  const WaitIcon = s.wait && WAIT_ICONS[s.wait.kind];

  return (
    <a
      className="space"
      href={`/space/${space.id}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(`/space/${space.id}`);
      }}
    >
      <div className="n">
        <span className="sd" style={{ background: space.color }} />
        <span className="name">{space.name}</span>
        <span className="tags">
          {space.private && <span className="tag private">Private</span>}
          <span className="tag">{space.kind}</span>
        </span>
      </div>
      <div className={`s${s.tone ? ` ${s.tone}` : ""}`} title={s.text}>
        {WaitIcon && <WaitIcon />}
        <span>
          <Plain text={s.text} />
        </span>
      </div>
      {open.length > 0 && (
        <ul className="tasks">
          {open.slice(0, SHOWN_TASKS).map((t) => (
            <li key={t.id}>
              <StatusIcon status={t.status} />
              <span>{t.title}</span>
            </li>
          ))}
          {open.length > SHOWN_TASKS && <li className="more">+{open.length - SHOWN_TASKS} more</li>}
        </ul>
      )}
      <div className="agents">
        {(agents.length ? agents : ["claude"]).map((a) => (
          <Avatar key={a} agent={a} live={live.has(a)} />
        ))}
      </div>
    </a>
  );
}

// Composed from live state on every render so counts never go stale while the page stays open.
function liveStatus(state: State): string {
  const parts: string[] = [];
  const pending = state.approvals.length + state.proposals.length;
  if (pending > 0) parts.push(`${pending} ${pending === 1 ? "thing needs" : "things need"} you`);
  const blocked = state.tasks.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    const reason = blocked[0]!.blockedReason;
    parts.push(`${blocked.length} blocked${reason ? ` (${reason})` : ""}`);
  }
  // Queueing behind a running task is the normal case, not news.
  const waits = waitsOf(state.tasks, state).filter((w) => w.kind !== "busy");
  if (waits.length > 0) {
    const more = waits.length - 1;
    parts.push(`${waits[0]!.reason.replace(/\.$/, "")}${more > 0 ? ` (${more} more ${more === 1 ? "task" : "tasks"} waiting)` : ""}`);
  }
  return parts.length ? ` ${parts.join(". ")}.` : "";
}

type Props = {
  state: State;
  briefing: State["briefing"];
  onNewSpace: () => void;
};

export function Home({ state, briefing, onNewSpace }: Props) {
  if (state.spaces.length === 0) {
    return (
      <div className="wrap">
        <div className="hero-empty">
          <Logo className="big" />
          <h1>{briefing.greeting}</h1>
          <p>Nothing here yet. Describe your first space below.</p>
          <ArrowDown className="arrow" />
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <h1>{briefing.greeting}</h1>
      <p className="brief">
        {briefing.summary}
        <Plain text={liveStatus(state)} />
      </p>

      <NeedsYou state={state} />

      <h2>Spaces</h2>
      <div className="grid">
        {state.spaces.map((s) => (
          <SpaceCard key={s.id} space={s} state={state} />
        ))}
        <button className="new" onClick={onNewSpace}>
          <span className="new-label">
            <Plus />
            New space
          </span>
          <small>just describe it</small>
        </button>
      </div>

      <Activity state={state} />
    </div>
  );
}
