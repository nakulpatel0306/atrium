import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { post, type State, useEngineState, useOnline } from "./api";
import { CommandBar } from "./components/CommandBar";
import { Home } from "./components/Home";
import { Sidebar } from "./components/Sidebar";
import { navigate, parseRoute, usePath } from "./route";

type Space = State["spaces"][number];

// Placeholder until the space view lands; it only confirms where the user is.
function SpaceStub({ space }: { space: Space | undefined }) {
  if (!space) {
    return (
      <div className="wrap">
        <h1>Space not found</h1>
        <p className="brief">It may have been archived. Pick another space from the sidebar.</p>
      </div>
    );
  }
  return (
    <div className="wrap">
      <h1>{space.name}</h1>
      <p className="brief">{space.goal}</p>
    </div>
  );
}

function App() {
  const state = useEngineState();
  const online = useOnline();
  const route = parseRoute(usePath());
  const main = useRef<HTMLElement>(null);
  // Marking seen rewrites the briefing to "nothing since you were last here", so keep the one shown on open.
  const briefing = useRef<State["briefing"] | null>(null);
  const seen = useRef(false);
  const [setupRequest, setSetupRequest] = useState(0);
  const [jump, setJump] = useState<"needs" | "activity" | null>(null);
  const [, setTick] = useState(0);

  if (state && !briefing.current) briefing.current = state.briefing;

  useEffect(() => {
    if (!state || seen.current) return;
    seen.current = true;
    void post("/api/seen");
  }, [state]);

  // Keeps relative times ("3m ago") current while nothing else changes.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [route.name, route.name === "space" ? route.id : ""]);

  useEffect(() => {
    if (!jump || route.name !== "home") return;
    document.getElementById(jump)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setJump(null);
  }, [jump, route.name]);

  const space = route.name === "space" ? state?.spaces.find((s) => s.id === route.id) : undefined;
  const newSpace = () => setSetupRequest((n) => n + 1);
  const offline = !online && <span className="offline">Reconnecting…</span>;

  if (!state) {
    return (
      <div className="hero-empty" style={{ minHeight: "100vh" }}>
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
        state={state}
        route={route}
        onNewSpace={newSpace}
        onJump={(section) => {
          navigate("/");
          setJump(section);
        }}
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
              / <b>{space?.name ?? "Unknown space"}</b>
            </>
          )}
          {offline}
          <span className="k">⌘K</span>
        </div>
        {route.name === "home" ? (
          <Home state={state} briefing={briefing.current ?? state.briefing} onNewSpace={newSpace} />
        ) : (
          <SpaceStub space={space} />
        )}
        <CommandBar space={route.name === "space" ? (space ?? null) : null} setupRequest={setupRequest} />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
