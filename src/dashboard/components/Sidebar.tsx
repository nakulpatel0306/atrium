import { Activity, BatteryMedium, Bot, House, Inbox, Moon, Plug, Plus, Settings, ShieldCheck } from "lucide-react";
import { post, type State } from "../api";
import { bytes, tokens } from "../format";
import { navigate, type Route } from "../route";
import { WindowBar } from "./Agents";
import { Logo } from "./Logo";

type Props = {
  state: State;
  route: Route;
  onNewSpace: () => void;
  onJump: (section: "needs" | "activity") => void;
};

export function Sidebar({ state, route, onNewSpace, onJump }: Props) {
  // Suggestions wait for an answer just like approvals do.
  const waiting = [...state.approvals, ...state.proposals];
  const pending = waiting.length;
  const pendingBySpace = new Map<string, number>();
  for (const a of waiting) pendingBySpace.set(a.spaceId, (pendingBySpace.get(a.spaceId) ?? 0) + 1);
  const activeRules = state.rules.filter((r) => r.state === "active").length;
  const battery = state.power.source === "battery";
  // Agents that can't take work right now: missing, signed out, or at a limit.
  const held = Object.values(state.agents).filter((a) => !a.installed || a.loggedIn === false || a.limitedUntil).length;
  const window = state.claudeWindow;

  return (
    <aside>
      <div className="ws">
        <Logo />
        Atrium
      </div>
      <button className={`nav${route.name === "home" ? " on" : ""}`} onClick={() => navigate("/")}>
        <House />
        Home
      </button>
      <button className="nav" onClick={() => onJump("needs")}>
        <Inbox />
        Needs you
        {pending > 0 && <span className="ct hot">{pending}</span>}
      </button>
      <button className="nav" onClick={() => onJump("activity")}>
        <Activity />
        Activity
      </button>
      <button className={`nav${route.name === "agents" ? " on" : ""}`} onClick={() => navigate("/agents")}>
        <Bot />
        Agents
        {held > 0 && (
          <span className="ct warn" title={`${held} can't take work right now`}>
            {held}
          </span>
        )}
      </button>
      <button className={`nav${route.name === "rules" ? " on" : ""}`} onClick={() => navigate("/rules")}>
        <ShieldCheck />
        Rules
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
            onClick={() => navigate(`/space/${s.id}`)}
          >
            <span className="sd" style={{ background: s.color }} />
            <span className="label">{s.name}</span>
            {n > 0 && <span className="ct">{n}</span>}
          </button>
        );
      })}

      <div className="foot">
        <button className={`nav${route.name === "settings" ? " on" : ""}`} onClick={() => navigate("/settings")}>
          <Settings />
          Settings
        </button>
        <div className="row">
          <span>Claude · last 24h</span>
          <span className="val">{tokens(state.usage.claudeTokens24h)} tokens</span>
        </div>
        {window && (
          <button className="window-mini" onClick={() => navigate("/agents")} title="Claude's five-hour window, estimated">
            <span className="row">
              <span>Claude · 5h window</span>
              <span className="val">{Math.round(window.utilization * 100)}%</span>
            </span>
            <WindowBar state={state} compact />
          </button>
        )}
        <div className={`power${battery ? " battery" : ""}`}>
          {battery ? <BatteryMedium /> : <Plug />}
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
            <Moon />
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
