import { LoaderCircle, Sparkle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AgentChoice, agentName } from "../agents";
import { post, type State } from "../api";
import { navigate } from "../route";
import { AgentPicker } from "./AgentPicker";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

type Props = {
  space: Space | null;
  // Bumped by the sidebar "+" and the "New space" card to switch into setup mode and focus.
  setupRequest: number;
};

type Message = { kind: "busy" | "error" | "info"; text: string } | null;

export function CommandBar({ space, setupRequest }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [forceSetup, setForceSetup] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [agent, setAgent] = useState<AgentChoice>("auto");
  const busy = message?.kind === "busy";
  const setup = !space || forceSetup;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (setupRequest === 0) return;
    setForceSetup(true);
    input.current?.focus();
  }, [setupRequest]);

  // Text typed for one place (a new space, or another space's task) shouldn't follow the user elsewhere.
  useEffect(() => {
    setForceSetup(false);
    setAgent("auto");
    if (busy) return;
    setText("");
    setMessage(null);
  }, [space?.id]);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    if (setup) {
      setMessage({ kind: "busy", text: "Setting up your space. This usually takes under a minute." });
      const res = await post<{ space: Space; tasks: Task[] }>("/api/command", { text: value });
      if (!res.ok) return setMessage({ kind: "error", text: res.error });
      setText("");
      setMessage(null);
      navigate(`/space/${res.data.space.id}`);
    } else {
      setMessage({ kind: "busy", text: "Adding the task…" });
      const res = await post<{ task: Task }>("/api/command", { text: value, spaceId: space!.id, agent });
      if (!res.ok) return setMessage({ kind: "error", text: res.error });
      setText("");
      const by = agent === "auto" ? "" : ` for ${agentName(agent)}`;
      setMessage({ kind: "info", text: `Queued "${res.data.task.title}" in ${space!.name}${by}.` });
    }
  };

  const placeholder = setup
    ? 'Describe something new to set up, e.g. "keep my job search organized"'
    : `Give ${space!.name} a task…`;

  return (
    <div className="cmd">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {busy ? <LoaderCircle className="spinner" /> : <Sparkle />}
        <input
          ref={input}
          value={text}
          readOnly={busy}
          aria-label={setup ? "Describe a new space" : `Give ${space!.name} a task`}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            if (message?.kind !== "busy") setMessage(null);
          }}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        />
        {!setup && <AgentPicker value={agent} disabled={busy} onChange={setAgent} label="Agent for the new task" />}
        <span className="k">⌘K</span>
      </form>
      {message && (
        <div className={`msg${message.kind === "error" ? " err" : ""}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </div>
      )}
    </div>
  );
}
