import { post, type State } from "../api";
import { bytes, tokens } from "../format";
import { navigate, type Route } from "../route";

type Props = {
  state: State;
  route: Route;
  onNewSpace: () => void;
  onJump: (section: "needs" | "activity") => void;
};

export function Sidebar({ state, route, onNewSpace, onJump }: Props) {
  const pending = state.approvals.length;
  const pendingBySpace = new Map<string, number>();
  for (const a of state.approvals) pendingBySpace.set(a.spaceId, (pendingBySpace.get(a.spaceId) ?? 0) + 1);
  const battery = state.power.source === "battery";

  return (
    <aside>
      <div className="ws">
        <div className="logo" />
        Atrium
      </div>
      <button className={`nav${route.name === "home" ? " on" : ""}`} onClick={() => navigate("/")}>
        <span className="ic">⌂</span>Home
      </button>
      <button className="nav" onClick={() => onJump("needs")}>
        <span className="ic">◎</span>Needs you
        {pending > 0 && <span className="ct hot">{pending}</span>}
      </button>
      <button className="nav" onClick={() => onJump("activity")}>
        <span className="ic">≡</span>Activity
      </button>

      <div className="sec">
        <span>Spaces</span>
        <button className="add" onClick={onNewSpace} title="New space" aria-label="New space">
          +
        </button>
      </div>
      {state.spaces.map((s) => {
        const n = pendingBySpace.get(s.id) ?? 0;
        return (
          <button
            key={s.id}
            className={`nav${route.name === "space" && route.id === s.id ? " on" : ""}`}
            onClick={() => navigate(`/space/${s.id}`)}
          >
            <span className="sd" style={{ background: s.color }} />
            <span className="label">{s.name}</span>
            {n > 0 && <span className="ct">{n}</span>}
          </button>
        );
      })}

      <div className="foot">
        <div className="row">
          <span>Claude · last 24h</span>
          <span className="val">{tokens(state.usage.claudeTokens24h)} tokens</span>
        </div>
        <div className={`power${battery ? " battery" : ""}`}>
          <i />
          {battery ? "On battery · heavy work waits" : "Plugged in"}
        </div>
        <div>
          <button
            className="toggle"
            role="switch"
            aria-checked={state.power.overnight}
            onClick={() => void post("/api/settings", { overnight: !state.power.overnight })}
          >
            <span className="switch" />
            Overnight mode
          </button>
          <div className="hint">Keeps your Mac awake while plugged in and work is queued. Leave the lid open.</div>
        </div>
        <div className="row">
          <span>Atrium disk usage</span>
          <span className="val">{bytes(state.disk.totalBytes)}</span>
        </div>
      </div>
    </aside>
  );
}
