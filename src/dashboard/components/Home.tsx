import type { State } from "../api";
import { clock, relative } from "../format";
import { navigate } from "../route";
import { Activity } from "./Activity";
import { NeedsYou } from "./NeedsYou";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

const OPEN = new Set<Task["status"]>(["queued", "running", "review", "blocked", "failed"]);
const SHOWN_TASKS = 3;

const pausedText = (until: number) => `Paused: Claude usage limit, resumes at ${clock(until)}`;

function status(space: Space, tasks: Task[], state: State): { text: string; tone?: "blocked" | "waiting" } {
  const running = tasks.find((t) => t.status === "running");
  if (running) return { text: `Running · ${running.title}` };
  if (state.power.waiting && tasks.some((t) => t.id === state.power.waiting!.taskId)) {
    return { text: "Waiting for power", tone: "waiting" };
  }
  const stuck = tasks.filter((t) => t.status === "blocked" || t.status === "failed");
  if (stuck.length === 1 && stuck[0]!.status === "blocked") {
    return { text: `Blocked: ${stuck[0]!.blockedReason ?? stuck[0]!.title}`, tone: "blocked" };
  }
  if (stuck.length > 0) return { text: `${stuck.length} need${stuck.length === 1 ? "s" : ""} attention`, tone: "blocked" };
  const review = tasks.filter((t) => t.status === "review").length;
  if (review > 0) return { text: `${review} ready for your review` };
  const queued = tasks.filter((t) => t.status === "queued").length;
  if (queued > 0 && state.power.pausedUntil) return { text: pausedText(state.power.pausedUntil), tone: "waiting" };
  if (queued > 0) return { text: `${queued} ${queued === 1 ? "task" : "tasks"} queued` };
  const last = state.activity.find((a) => a.spaceId === space.id)?.createdAt ?? space.updatedAt;
  return { text: `Idle · last activity ${relative(last)}` };
}

function Avatar({ agent, live }: { agent: string; live: boolean }) {
  return (
    <span className={`av ${agent === "claude" ? "c-claude" : "c-other"}${live ? " live" : ""}`} title={agent}>
      {agent.charAt(0).toUpperCase()}
    </span>
  );
}

function SpaceCard({ space, state }: { space: Space; state: State }) {
  const tasks = state.tasks.filter((t) => t.spaceId === space.id);
  const open = tasks.filter((t) => OPEN.has(t.status));
  const s = status(space, tasks, state);
  const agents = [...new Set(tasks.map((t) => t.agent))];
  const live = new Set(tasks.filter((t) => t.status === "running").map((t) => t.agent));

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
      <div className={`s${s.tone ? ` ${s.tone}` : ""}`}>{s.text}</div>
      {open.length > 0 && (
        <ul className="tasks">
          {open.slice(0, SHOWN_TASKS).map((t) => (
            <li key={t.id}>
              <i className={`stat ${t.status}`} />
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
  const pending = state.approvals.length;
  if (pending > 0) parts.push(`${pending} ${pending === 1 ? "thing needs" : "things need"} you`);
  const blocked = state.tasks.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    const reason = blocked[0]!.blockedReason;
    parts.push(`${blocked.length} blocked${reason ? ` (${reason})` : ""}`);
  }
  if (state.power.waiting) parts.push("Heavy work is waiting for power");
  if (state.power.pausedUntil) parts.push(pausedText(state.power.pausedUntil));
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
          <h1>{briefing.greeting}</h1>
          <p>Nothing here yet. Describe your first space below.</p>
          <span className="arrow">↓</span>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <h1>{briefing.greeting}</h1>
      <p className="brief">
        {briefing.summary}
        {liveStatus(state)}
      </p>

      <NeedsYou state={state} />

      <h2>Spaces</h2>
      <div className="grid">
        {state.spaces.map((s) => (
          <SpaceCard key={s.id} space={s} state={state} />
        ))}
        <button className="new" onClick={onNewSpace}>
          + New space
          <small>just describe it</small>
        </button>
      </div>

      <Activity state={state} />
    </div>
  );
}
