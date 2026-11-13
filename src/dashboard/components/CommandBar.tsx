import { LoaderCircle, Paperclip, Sparkle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCEPT, REPO_REFUSED } from "../../engine/attachment-rules";
import { type AgentChoice, agentName } from "../agents";
import { post, type State } from "../api";
import { draggingFiles, filesOf, pastedName, renamed, setupWithFiles, sortFiles, uploadAttachments } from "../attachments";
import { announce } from "../live";
import { navigate } from "../route";
import { AgentPicker } from "./AgentPicker";
import { AttachChips } from "./AttachChips";
import { BriefCard, type Draft as BriefDraft } from "./BriefCard";
import type { Brief } from "../../engine/brief";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Draft = State["repoActions"][number];
type SetupReply = { space: Space; tasks: Task[] } | { draft: Draft };

type Props = {
  space: Space | null;
  // Bumped by the sidebar "+" and the "New space" card to switch into setup mode and focus.
  setupRequest: number;
};

type Message = { kind: "busy" | "error" | "info"; text: string } | null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function CommandBar({ space, setupRequest }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [forceSetup, setForceSetup] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [agent, setAgent] = useState<AgentChoice>("auto");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  // "Brief first" (⌘↩): the brief drafted from the ask, shown under it until it's run or discarded, and the
  // request drafting it, which Esc cancels.
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const drafting = useRef<AbortController | null>(null);
  // Files already saved in a space, so a retry after a failed send doesn't save them a second time.
  const uploaded = useRef(new Map<File, { spaceId: string; id: string }>());
  // Set when a message must survive the navigation that follows it.
  const keepMessage = useRef(false);
  const busy = message?.kind === "busy";
  const setup = !space || forceSetup;
  const repo = space?.kind === "repo" && !forceSetup;

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

  // Text typed for one place (a new space, or another space's task) shouldn't follow the user elsewhere. Attached
  // files do: they're what Nakul wants looked at, wherever he ends up sending them.
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
    setDraft(null);
  }, [space?.id]);

  // Chips make the bar taller, so pages leave more room at the bottom while there are any.
  useEffect(() => {
    const on = files.length > 0;
    document.documentElement.classList.toggle("has-attachments", on);
    return () => {
      if (on) document.documentElement.classList.remove("has-attachments");
    };
  }, [files.length > 0]);

  const attach = (incoming: File[]) => {
    if (!incoming.length || busy) return;
    if (repo) return setMessage({ kind: "error", text: REPO_REFUSED });
    // The good files go in even when some are refused; the refused ones are named.
    const { ok, refused } = sortFiles(incoming, files);
    if (ok.length) setFiles((prev) => [...prev, ...ok]);
    setMessage(refused.length ? { kind: "error", text: refused.join(" ") } : null);
    const added = ok.length === 0 ? "" : ok.length === 1 ? `Attached ${ok[0]!.name}` : `Attached ${plural(ok.length, "file")}`;
    announce([added, refused.length ? `${plural(refused.length, "file")} not attached.` : ""].filter(Boolean).join(". "));
  };
  const attachRef = useRef(attach);
  attachRef.current = attach;

  const remove = (f: File) => {
    setFiles((prev) => prev.filter((x) => x !== f));
    uploaded.current.delete(f);
    announce(`Removed ${f.name}`);
    input.current?.focus();
  };

  // The whole page takes a drop, so a file can land anywhere rather than on one small target. Every file drag is
  // claimed, even where it can't attach, so a missed drop never opens the file in place of the dashboard.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!draggingFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!draggingFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!draggingFiles(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!draggingFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      attachRef.current(filesOf(e.dataTransfer));
    };
    // A paste in another field (a note, a name) is that field's; one in the bar or on the page itself attaches.
    const paste = (e: ClipboardEvent) => {
      const pasted = filesOf(e.clipboardData);
      if (!pasted.length) return;
      const target = e.target as HTMLElement | null;
      const elsewhere = target && target !== input.current && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (elsewhere) return;
      e.preventDefault();
      const now = new Date();
      attachRef.current(pasted.map((f) => renamed(f, pastedName(f, now))));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, []);

  // Saves whatever isn't saved in this space yet; null (with the error shown) when that fails.
  const upload = async (spaceId: string): Promise<string[] | null> => {
    const fresh = files.filter((f) => uploaded.current.get(f)?.spaceId !== spaceId);
    if (fresh.length) {
      setMessage({ kind: "busy", text: `Attaching ${plural(fresh.length, "file")}…` });
      const res = await uploadAttachments(spaceId, fresh);
      if (!res.ok) {
        setMessage({ kind: "error", text: res.error });
        return null;
      }
      fresh.forEach((f, i) => uploaded.current.set(f, { spaceId, id: res.data[i]!.id }));
    }
    return files.map((f) => uploaded.current.get(f)!.id);
  };

  // Enter in a space runs the task at once (its brief is drafted as its first stage); ⌘↩ (`briefFirst`) drafts the
  // brief here to edit before running.
  const submit = async (briefFirst = false) => {
    const value = text.trim();
    if (busy) return;
    if (setup) {
      if (!value) {
        if (files.length) setMessage({ kind: "info", text: "Say what the new space is for first. Your files go to it once it's set up." });
        return;
      }
      setMessage({ kind: "busy", text: "Setting up your space. This usually takes under a minute." });
      // Files go along with the description, and the engine gives them to the new space's first task.
      const res = files.length ? await setupWithFiles<SetupReply>(value, files) : await post<SetupReply & { attached?: undefined }>("/api/command", { text: value });
      if (!res.ok) return setMessage({ kind: "error", text: res.error });
      setText("");
      const attached = res.data.attached?.length ?? 0;
      if (attached) {
        setFiles([]);
        uploaded.current.clear();
      }
      // A new project is only a draft until Nakul approves it in Needs you, which lives on Home.
      if ("draft" in res.data) {
        setMessage({ kind: "info", text: `Drafted "${res.data.draft.draft?.name}". Check it in Needs you and approve to create the repo.` });
        keepMessage.current = space !== null;
        navigate("/");
        return;
      }
      if (attached) {
        setMessage({ kind: "info", text: `${res.data.space.name} is ready. Its first task, "${res.data.tasks[0]?.title}", has your ${attached === 1 ? "file" : `${attached} files`}.` });
        keepMessage.current = true;
      } else if (files.length) {
        // A repo space can't take them; they stay attached so nothing is lost.
        setMessage({ kind: "info", text: `${res.data.space.name} is ready. ${REPO_REFUSED} Your files are still attached.` });
        keepMessage.current = true;
      } else setMessage(null);
      navigate(`/space/${res.data.space.id}`);
    } else {
      if (!value && !files.length) return;
      if (files.length && repo) return setMessage({ kind: "error", text: `${REPO_REFUSED} Remove the files to send this here.` });
      // Files alone ask the agent to look at them; there's nothing to brief.
      if (briefFirst && value) return draftBrief(value);
      await send(value);
    }
  };

  const draftBrief = async (value: string) => {
    const controller = new AbortController();
    drafting.current = controller;
    setMessage({ kind: "busy", text: "Drafting a brief to edit… Esc cancels." });
    const res = await post<BriefDraft>("/api/brief", { spaceId: space!.id, text: value }, controller.signal);
    drafting.current = null;
    if (controller.signal.aborted) return;
    if (!res.ok) return setMessage({ kind: "error", text: `${res.error} Press ↩ to run it as it is.` });
    setMessage(null);
    setDraft(res.data);
  };

  const cancelDraft = () => {
    drafting.current?.abort();
    drafting.current = null;
    setMessage(null);
    input.current?.focus();
  };

  const send = async (value: string, brief?: Brief) => {
    const attachments = files.length ? await upload(space!.id) : [];
    if (!attachments) return;
    setMessage({ kind: "busy", text: "Adding the task…" });
    const res = await post<{ task: Task }>("/api/command", { text: value, spaceId: space!.id, agent, ...(attachments.length && { attachments }), ...(brief && { brief }) });
    if (!res.ok) return setMessage({ kind: "error", text: res.error });
    setText("");
    setDraft(null);
    setFiles([]);
    uploaded.current.clear();
    const by = agent === "auto" ? "" : ` for ${agentName(agent)}`;
    const carrying = attachments.length ? ` with ${plural(attachments.length, "file")}` : "";
    const first = brief || !value ? "" : " Its brief is drafted first, on the task.";
    setMessage({ kind: "info", text: `Queued "${res.data.task.title}" in ${space!.name}${carrying}${by}.${first}` });
    input.current?.focus();
  };

  const placeholder = setup
    ? 'Describe something new, like "add dark mode to my site" or "start a new project called…"'
    : `Give ${space!.name} a task. ⌘↩ edits the brief first.`;

  return (
    <>
      {dragging && (
        <div className="drop-veil" aria-hidden="true">
          <div className="drop-card">
            <Paperclip />
            {repo ? REPO_REFUSED : busy ? "Wait for this to finish, then drop" : "Drop to attach"}
          </div>
        </div>
      )}
      <div className="cmd">
        {draft && !setup && (
          <BriefCard
            draft={draft}
            repo={repo}
            busy={busy}
            onRun={(brief) => void send(text.trim(), brief)}
            onDiscard={() => {
              setDraft(null);
              input.current?.focus();
            }}
          />
        )}
        <AttachChips files={files} onRemove={remove} disabled={busy} />
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
              // A brief is for the ask it was drafted from.
              setDraft(null);
              if (message?.kind !== "busy") setMessage(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && drafting.current) cancelDraft();
              else if (e.key === "Escape") e.currentTarget.blur();
              else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit(true);
              }
            }}
          />
          <button
            type="button"
            className="attach"
            aria-label={repo ? REPO_REFUSED : "Attach files"}
            title={repo ? REPO_REFUSED : "Attach files"}
            // aria-disabled rather than disabled in a repo space, so the tooltip saying why still shows on hover.
            aria-disabled={repo || undefined}
            disabled={busy}
            onClick={() => (repo ? setMessage({ kind: "info", text: REPO_REFUSED }) : picker.current?.click())}
          >
            <Paperclip />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            tabIndex={-1}
            onChange={(e) => {
              attach([...(e.currentTarget.files ?? [])]);
              e.currentTarget.value = "";
            }}
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
    </>
  );
}
