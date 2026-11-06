import { LoaderCircle, Sparkle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type AgentChoice, agentName } from "../agents";
import { post, type State } from "../api";
import { navigate } from "../route";
import { AgentPicker } from "./AgentPicker";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Draft = State["repoActions"][number];
type Text = State["messageActions"][number];
type SetupReply = { space: Space; tasks: Task[]; messaging?: true } | { draft: Draft } | { message: Text };

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
  // Set when a message must survive the navigation that follows it.
  const keepMessage = useRef(false);
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
    if (keepMessage.current) {
      keepMessage.current = false;
      return;
    }
    if (busy) return;
    setText("");
    setMessage(null);
  }, [space?.id]);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    if (setup) {
      setMessage({ kind: "busy", text: "Setting up your space. This usually takes under a minute." });
      const res = await post<SetupReply>("/api/command", { text: value });
      if (!res.ok) return setMessage({ kind: "error", text: res.error });
      setText("");
      // A new project is only a draft until Nakul approves it in Needs you, which lives on Home.
      if ("draft" in res.data) {
        setMessage({ kind: "info", text: `Drafted "${res.data.draft.draft?.name}". Check it in Needs you and approve to create the repo.` });
        keepMessage.current = space !== null;
        navigate("/");
        return;
      }
      // A text with its words is a card in Needs you right away; one without waits for an agent to draft it.
      if ("message" in res.data) {
        setMessage({ kind: "info", text: `Drafted a text to ${res.data.message.toName}. It's waiting in Needs you.` });
        keepMessage.current = space !== null;
        navigate("/");
        return;
      }
      if (res.data.messaging) {
        const to = res.data.tasks[0]?.title.replace(/^Draft a text to /, "") ?? "them";
        setMessage({ kind: "info", text: `Atrium is drafting a text to ${to}. It'll be in Needs you to send.` });
        keepMessage.current = true;
        navigate(`/space/${res.data.space.id}`);
        return;
      }
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
    ? 'Describe something new, like "keep my job search organized" or "start a new project called…"'
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
