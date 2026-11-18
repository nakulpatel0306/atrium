import { Activity, Archive, BatteryMedium, Bot, House, Inbox, Moon, PanelLeftClose, PanelLeftOpen, Plug, Plus, Settings, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { agentsHeld } from "../agents";
import { post, type State } from "../api";
import { bytes } from "../format";
import { navigate, type Route } from "../route";
import { WindowBar } from "./Agents";
import { showArchived } from "./ArchivedSpaces";
import { needsCount, waitingIn } from "./NeedsYou";
import { PlumStatus } from "./PlumStatus";

type Props = {
  state: State;
  archived: number;
  route: Route;
  onNewSpace: () => void;
};

// A real link, so a space or page opens in a new tab with ⌘-click; a plain click stays in the page.
function NavLink({ href, children, ...rest }: { href: string; className: string; title: string; children: ReactNode }) {
  return (
    <a
      {...rest}
      href={href}
      aria-current={rest.className.includes(" on") ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

export function Sidebar({ state, archived, route, onNewSpace }: Props) {
  // Suggestions and tasks asking before they start wait for an answer just like approvals do.
  const pending = needsCount(state);
  const activeRules = state.rules.filter((r) => r.state === "active").length;
  const battery = state.power.source === "battery";
  const held = agentsHeld(state);
  const window = state.claudeWindow;
  // On a narrow window the sidebar is an icon rail; a tap opens it over the page with every name. Any of its actions,
  // a tap on the page behind it, or Esc closes it again.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    // `window` here is Claude's usage window, so the page's is reached through globalThis.
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <>
    {expanded && <div className="rail-scrim" aria-hidden="true" onClick={() => setExpanded(false)} />}
    <aside
      className={expanded ? "open" : undefined}
      onClick={(e) => {
        const hit = (e.target as Element).closest("a, button");
        if (hit && !hit.classList.contains("rail-toggle")) setExpanded(false);
      }}
    >
      <button className="rail-toggle" aria-expanded={expanded} aria-label={expanded ? "Hide names" : "Show names"} title={expanded ? "Hide names" : "Show names"} onClick={() => setExpanded(!expanded)}>
        {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
      </button>
      <div className="ws">
        <span className="label">atrium</span>
      </div>
      <NavLink className={`nav${route.name === "home" ? " on" : ""}`} title="Home" href="/">
        <House />
        <span className="label">Home</span>
      </NavLink>
      <NavLink className={`nav${route.name === "needs" ? " on" : ""}`} title="Needs you" href="/needs-you">
        <Inbox />
        <span className="label">Needs you</span>
        {pending > 0 && <span className="ct hot">{pending}</span>}
      </NavLink>
      <NavLink className={`nav${route.name === "activity" ? " on" : ""}`} title="Activity" href="/activity">
        <Activity />
        <span className="label">Activity</span>
      </NavLink>
      <NavLink className={`nav${route.name === "agents" ? " on" : ""}`} title="Agents" href="/agents">
        <Bot />
        <span className="label">Agents</span>
        {held > 0 && (
          <span className="ct warn" title={`${held} can't take work right now`}>
            {held}
          </span>
        )}
      </NavLink>
      <NavLink className={`nav${route.name === "rules" ? " on" : ""}`} title="Rules" href="/rules">
        <ShieldCheck />
        <span className="label">Rules</span>
        {activeRules > 0 && (
          <span className="ct" title={`${activeRules} active`}>
            {activeRules}
          </span>
        )}
      </NavLink>

      <div className="sec">
        <span>Spaces</span>
        <button className="add" onClick={onNewSpace} title="New space" aria-label="New space">
          <Plus />
        </button>
      </div>
      {state.spaces.map((s) => {
        const n = waitingIn(state, s.id);
        return (
          <NavLink key={s.id} className={`nav${route.name === "space" && route.id === s.id ? " on" : ""}`} title={s.name} href={`/space/${s.id}`}>
            <span className="sd" style={{ background: s.color }} />
            <span className="label">{s.name}</span>
            {n > 0 && <span className="ct">{n}</span>}
          </NavLink>
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
        <PlumStatus state={state} />
        <NavLink className={`nav${route.name === "settings" ? " on" : ""}`} title="Settings" href="/settings">
          <Settings />
          <span className="label">Settings</span>
        </NavLink>
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
            title="Keeps your Mac awake while plugged in and work is queued. Leave the lid open."
            onClick={() => void post("/api/settings", { overnight: !state.power.overnight })}
          >
            <span className="switch" />
            <Moon />
            <span className="label">Overnight mode</span>
          </button>
        </div>
        <div className="row">
          <span>Atrium disk usage</span>
          <span className="val">{bytes(state.disk.totalBytes)}</span>
        </div>
      </div>
    </aside>
    </>
  );
}
