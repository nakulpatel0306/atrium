import type { State } from "../api";
import { relative } from "../format";
import { navigate } from "../route";
import { Activity } from "./Activity";
import { NeedsYou } from "./NeedsYou";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

const OPEN = new Set<Task["status"]>(["queued", "running", "review", "blocked", "failed"]);
const SHOWN_TASKS = 3;

function status(space: Space, tasks: Task[], state: State): { text: string; tone?: "blocked" | "waiting" } {
  const running = tasks.find((t) => t.status === "running");
  if (running) return { text: `Running · ${running.title}` };
  if (state.power.waiting && tasks.some((t) => t.id === state.power.waiting!.taskId)) {
    return { text: "Waiting for power", tone: "waiting" };
  }
  const blocked = tasks.find((t) => t.status === "blocked");
  if (blocked) return { text: `Blocked: ${blocked.blockedReason ?? blocked.title}`, tone: "blocked" };
  const review = tasks.filter((t) => t.status === "review").length;
  if (review > 0) return { text: `${review} ready for your review` };
  const queued = tasks.filter((t) => t.status === "queued").length;
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
      <p className="brief">{briefing.summary}</p>

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
