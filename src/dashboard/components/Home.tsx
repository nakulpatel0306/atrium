import { ArrowDown, CandlestickChart, Plus } from "lucide-react";
import { ranAgent } from "../agents";
import type { State } from "../api";
import { briefingMarketsLine } from "../markets";
import { navigate } from "../route";
import { emptyHome, liveStatus, spaceStatus } from "../summary";
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

function SpaceCard({ space, state }: { space: Space; state: State }) {
  const tasks = state.tasks.filter((t) => t.spaceId === space.id);
  const open = tasks.filter((t) => OPEN.has(t.status));
  const s = spaceStatus(space, tasks, state);
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
        <span className="name" title={space.name}>
          {space.name}
        </span>
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

type Props = {
  state: State;
  briefing: State["briefing"];
  onNewSpace: () => void;
};

export function Home({ state, briefing, onNewSpace }: Props) {
  if (emptyHome(state)) {
    return (
      <div className="wrap">
        <div className="hero-empty">
          <Logo className="big" />
          <h1>{briefing.greeting}</h1>
          <p>Nothing here yet. Describe your first space below.</p>
          <button className="btn" onClick={() => navigate("/start")}>
            Get started
          </button>
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
      {/* Live, unlike the summary above: prices and paper P&L keep moving while the page is open. */}
      {state.briefing.markets && briefingMarketsLine(state.briefing.markets) && (
        <p className="brief briefing-markets">
          <CandlestickChart />
          {briefingMarketsLine(state.briefing.markets)}
        </p>
      )}

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
          <small>Describe it in a sentence and Atrium sets it up.</small>
        </button>
      </div>

      <Activity state={state} />
    </div>
  );
}
