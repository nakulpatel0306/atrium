import { useEffect, useRef, useState } from "react";
import { LucideProvider, ChevronRight, Unplug } from "lucide-react";
import { createRoot } from "react-dom/client";
import { activeOnly, post, type State, useEngineState, useOnline } from "./api";
import { Agents } from "./components/Agents";
import { CommandBar } from "./components/CommandBar";
import { GetStarted } from "./components/GetStarted";
import { Home } from "./components/Home";
import { LiveRegion } from "./components/LiveRegion";
import { NeedsPage } from "./components/NeedsPage";
import { Activity } from "./components/Activity";
import { Logo } from "./components/Logo";
import { Rules } from "./components/Rules";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { SpaceView } from "./components/SpaceView";
import { Toast } from "./components/Toast";
import { navigate, parseRoute, usePath } from "./route";

function App() {
  const state = useEngineState();
  const online = useOnline();
  const path = usePath();
  const route = parseRoute(path);
  const main = useRef<HTMLElement>(null);
  // Marking seen rewrites the briefing to "nothing since you were last here", so keep the one shown on open.
  const briefing = useRef<State["briefing"] | null>(null);
  const seen = useRef(false);
  const [setupRequest, setSetupRequest] = useState(0);
  const [, setTick] = useState(0);

  if (state && !briefing.current) briefing.current = state.briefing;

  useEffect(() => {
    if (!state || seen.current) return;
    seen.current = true;
    void post("/api/seen");
  }, [state]);

  // A fresh engine that hasn't finished Get started opens it once; after that it's only reachable from Settings.
  const asked = useRef(false);
  const fresh = state !== null && state.spaces.length === 0;
  useEffect(() => {
    if (!fresh || asked.current || route.name !== "home") return;
    asked.current = true;
    void fetch("/api/start")
      .then((r) => r.json() as Promise<{ autoOpen: boolean }>)
      .then((r) => r.autoOpen && navigate("/start"))
      .catch(() => {});
  }, [fresh, route.name]);

  // Keeps relative times ("3m ago") current while nothing else changes.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [route.name, route.name === "space" ? route.id : ""]);

  const space = route.name === "space" ? state?.spaces.find((s) => s.id === route.id) : undefined;
  const newSpace = () => setSetupRequest((n) => n + 1);
  const offline = !online && (
    <span className="offline" role="status">
      <Unplug />
      Reconnecting…
    </span>
  );

  if (!state) {
    return (
      <div className="hero-empty" style={{ minHeight: "100vh" }}>
        <Logo className="big" label="Atrium" />
        {online ? (
          <p>Connecting to Atrium…</p>
        ) : (
          <p>Can't reach the Atrium engine. Start it again and this page will reconnect on its own.</p>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        state={activeOnly(state)}
        archived={state.archived?.length ?? 0}
        route={route}
        onNewSpace={newSpace}
      />
      <main ref={main}>
        <div className="top">
          {route.name === "home" ? (
            <>
              <b>Home</b> ·{" "}
              {new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
            </>
          ) : (
            <>
              <button className="crumb" onClick={() => navigate("/")}>
                Home
              </button>
              <ChevronRight className="sep" />
              <b>
                {route.name === "needs" ? "Needs you" : route.name === "activity" ? "Activity" : route.name === "agents" ? "Agents" : route.name === "rules" ? "Rules" : route.name === "settings" ? "Settings" : route.name === "start" ? "Get started" : (space?.name ?? "Unknown space")}
              </b>
            </>
          )}
          {offline}
          <span className="k">⌘K</span>
        </div>
        {route.name === "home" ? (
          <Home state={activeOnly(state)} briefing={briefing.current ?? state.briefing} onNewSpace={newSpace} />
        ) : route.name === "needs" ? (
          <NeedsPage state={activeOnly(state)} />
        ) : route.name === "activity" ? (
          <div className="wrap">
            <Activity state={activeOnly(state)} page />
          </div>
        ) : route.name === "agents" ? (
          <Agents state={state} />
        ) : route.name === "rules" ? (
          <Rules state={state} />
        ) : route.name === "settings" ? (
          <Settings />
        ) : route.name === "start" ? (
          <GetStarted />
        ) : (
          <SpaceView key={route.id} state={state} space={space} focusTask={route.task} tab={route.tab} symbol={route.symbol} money={route.money} changes={route.changes} />
        )}
        <CommandBar space={route.name === "space" ? (space ?? null) : null} setupRequest={setupRequest} />
        <Toast />
        <LiveRegion />
      </main>
    </div>
  );
}

// Every icon shares one size and stroke so the set reads as a single family.
createRoot(document.getElementById("root")!).render(
  <LucideProvider size={16} strokeWidth={1.5}>
    <App />
  </LucideProvider>,
);
