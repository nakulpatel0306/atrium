import { Activity, Archive, BatteryMedium, Bot, House, Inbox, Moon, Plug, Plus, Settings, ShieldCheck } from "lucide-react";
import { post, type State } from "../api";
import { bytes } from "../format";
import { navigate, type Route } from "../route";
import { WindowBar } from "./Agents";
import { showArchived } from "./ArchivedSpaces";
import { Logo } from "./Logo";

type Props = {
  state: State;
  archived: number;
  route: Route;
  onNewSpace: () => void;
};

export function Sidebar({ state, archived, route, onNewSpace }: Props) {
  // Suggestions wait for an answer just like approvals do.
  const waiting = [...state.approvals, ...state.proposals];
  const pending = waiting.length;
  const pendingBySpace = new Map<string, number>();
  for (const a of waiting) if (a.spaceId) pendingBySpace.set(a.spaceId, (pendingBySpace.get(a.spaceId) ?? 0) + 1);
  const activeRules = state.rules.filter((r) => r.state === "active").length;
  const battery = state.power.source === "battery";
  // Agents that can't take work right now: missing, signed out, or at a limit.
  const held = Object.values(state.agents).filter((a) => !a.installed || a.loggedIn === false || a.limitedUntil).length;
  const window = state.claudeWindow;

  return (
    <aside>
      <div className="ws">
        <Logo />
        <span className="label">Atrium</span>
      </div>
      <button className={`nav${route.name === "home" ? " on" : ""}`} title="Home" onClick={() => navigate("/")}>
        <House />
        <span className="label">Home</span>
      </button>
      <button className={`nav${route.name === "needs" ? " on" : ""}`} title="Needs you" onClick={() => navigate("/needs-you")}>
        <Inbox />
        <span className="label">Needs you</span>
        {pending > 0 && <span className="ct hot">{pending}</span>}
      </button>
      <button className={`nav${route.name === "activity" ? " on" : ""}`} title="Activity" onClick={() => navigate("/activity")}>
        <Activity />
        <span className="label">Activity</span>
      </button>
      <button className={`nav${route.name === "agents" ? " on" : ""}`} title="Agents" onClick={() => navigate("/agents")}>
        <Bot />
        <span className="label">Agents</span>
        {held > 0 && (
          <span className="ct warn" title={`${held} can't take work right now`}>
            {held}
          </span>
        )}
      </button>
      <button className={`nav${route.name === "rules" ? " on" : ""}`} title="Rules" onClick={() => navigate("/rules")}>
        <ShieldCheck />
        <span className="label">Rules</span>
        {activeRules > 0 && (
          <span className="ct" title={`${activeRules} active`}>
            {activeRules}
          </span>
        )}
      </button>

      <div className="sec">
        <span>Spaces</span>
        <button className="add" onClick={onNewSpace} title="New space" aria-label="New space">
          <Plus />
        </button>
      </div>
      {state.spaces.map((s) => {
        const n = pendingBySpace.get(s.id) ?? 0;
        return (
          <button
            key={s.id}
            className={`nav${route.name === "space" && route.id === s.id ? " on" : ""}`}
            title={s.name}
            onClick={() => navigate(`/space/${s.id}`)}
          >
            <span className="sd" style={{ background: s.color }} />
            <span className="label">{s.name}</span>
            {n > 0 && <span className="ct">{n}</span>}
          </button>
        );
      })}
      {archived > 0 && (
        <button
          className="nav archived-link"
          title="Archived"
          onClick={() => {
            navigate("/settings#archived");
            showArchived();
          }}
        >
          <Archive />
          <span className="label">Archived</span>
          <span className="ct">{archived}</span>
        </button>
      )}

      <div className="foot">
        <button className={`nav${route.name === "settings" ? " on" : ""}`} title="Settings" onClick={() => navigate("/settings")}>
          <Settings />
          <span className="label">Settings</span>
        </button>
        {window && (
          <button className="window-mini" onClick={() => navigate("/agents")} title="Claude's five-hour window, estimated">
            <span className="row">
              <span>Claude · 5h window</span>
              <span className="val">{Math.round(window.utilization * 100)}%</span>
            </span>
            <WindowBar state={state} compact />
          </button>
        )}
        <div className={`power${battery ? " battery" : ""}`} title={battery ? "On battery · heavy work waits" : "Plugged in"}>
          {battery ? <BatteryMedium /> : <Plug />}
          <span className="label">{battery ? "On battery · heavy work waits" : "Plugged in"}</span>
        </div>
        <div>
          <button
            className="toggle"
            role="switch"
            aria-checked={state.power.overnight}
            title="Overnight mode"
            onClick={() => void post("/api/settings", { overnight: !state.power.overnight })}
          >
            <span className="switch" />
            <Moon />
            <span className="label">Overnight mode</span>
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
