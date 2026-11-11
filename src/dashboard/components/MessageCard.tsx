import { type LucideIcon, MessageSquare, Search, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Candidate } from "../../engine/messaging/store";
import { displayHandle, handleProblem, MAX_TEXT, textLength, textProblem } from "../../engine/messaging/rules";
import { post, type State } from "../api";
import { announce } from "../live";
import { sendWithUndo } from "../pending-send";

type Approval = State["approvals"][number];
type Action = State["messageActions"][number];
type Lookup = { candidates: Candidate[]; picked: string | null; message: string | null };

const SOURCE: Record<string, string> = { contacts: "from Contacts", you: "typed by you" };

export const candidateLine = (c: Candidate) => [c.name, c.label, displayHandle(c.handle)].filter(Boolean).join(" · ");

// A text's first line, short enough that the closing quote still shows on a folded row.
export const snippet = (text: string, max = 40) => {
  const line = text.split("\n")[0]!.trim();
  return `‘${line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line}’`;
};

// Enter in the number field runs the lookup. The card has no form, so no key press can reach Send.
export function onNumberKey(e: { key: string; preventDefault: () => void }, lookup: () => void): void {
  if (e.key !== "Enter") return;
  e.preventDefault();
  lookup();
}

// A text waiting to go. What Nakul sees here is exactly what Messages gets: his edits and his Send land together,
// and nothing else can send it.
// Folded, as in a list, it's one line until Review opens it; a failed try opens on its own so the reason shows.
export function MessageCard({ approval, action, spaceName = "Messages", firstSend = false, folded = false }: { approval: Approval; action: Action; spaceName?: string; firstSend?: boolean; folded?: boolean }) {
  const [open, setOpen] = useState(!folded || !!action.lastError);
  const [text, setText] = useState(action.text);
  const [handle, setHandle] = useState(action.handle ? displayHandle(action.handle) : "");
  const [service, setService] = useState(action.service);
  const [candidates, setCandidates] = useState<Candidate[]>(action.candidates ?? []);
  const [found, setFound] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "decline" | "lookup" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Until Nakul types in the number field, a lookup the engine finishes later (or one from another app) fills it in.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched) return;
    if (action.handle) setHandle(displayHandle(action.handle));
    if (action.candidates) setCandidates(action.candidates);
  }, [action.handle, action.candidates, touched]);

  const textIssue = textProblem(text);
  const handleIssue = handle.trim() ? handleProblem(handle) : null;
  const canSend = !busy && !textIssue && handle.trim() !== "" && !handleIssue;
  const shown = handle.trim() && !handleIssue ? handle.trim() : null;
  const stored = action.handle && shown === displayHandle(action.handle);
  // A number from Contacts names the card it came from, so a match on the wrong person shows.
  const match = shown ? candidates.find((c) => displayHandle(c.handle) === shown) : undefined;
  const fromContacts = match ? `from Contacts · ${[match.name, match.label].filter(Boolean).join(", ")}` : SOURCE.contacts;
  const source = match || (stored && action.handleSource === "contacts") ? fromContacts : stored ? SOURCE[action.handleSource ?? ""] : shown ? SOURCE.you : null;

  const send = () => {
    if (!canSend) return;
    setBusy("send");
    setError(null);
    // The words and number are fixed at the press; the card is read-only until the send goes or is undone.
    const body = { text, handle, service };
    sendWithUndo(
      action.toName,
      async () => {
        const res = await post(`/api/message-actions/${action.id}/send`, body);
        // On success the card leaves with the next state push; the space's history shows the send.
        if (res.ok) return announce(`Sent to ${action.toName}.`);
        setError(res.error);
        setBusy(null);
        announce(`Didn't send to ${action.toName}. ${res.error}`);
      },
      () => setBusy(null),
    );
  };
  const decline = async () => {
    setBusy("decline");
    const res = await post(`/api/approvals/${approval.id}`, { decision: "reject" });
    if (!res.ok) {
      setError(res.error);
      setBusy(null);
    }
  };
  const lookup = async () => {
    setBusy("lookup");
    setLookupError(null);
    setFound(null);
    const res = await post<Lookup>(`/api/message-actions/${action.id}/lookup`);
    setBusy(null);
    if (!res.ok) return setLookupError(res.error);
    setCandidates(res.data.candidates);
    setFound(res.data.message);
    if (res.data.picked) setHandle(displayHandle(res.data.picked));
  };
  const openSettings = async () => {
    const res = await post("/api/messaging/open-settings", { pane: "automation" });
    if (!res.ok) setLookupError(res.error);
  };
  // The button sits under whichever message tells him to open System Settings.
  const needsPane = (msg: string | null) => !!msg && /System Settings/.test(msg);
  const settingsButton = (
    <button className="btn" type="button" onClick={() => void openSettings()}>
      <Settings2 />
      Open System Settings
    </button>
  );

  if (!open) return <FoldedText icon={MessageSquare} spaceName={spaceName} to={action.toName} text={text} onOpen={() => setOpen(true)} />;

  return (
    <div className="entry msg-entry">
      <div className="item">
        <MessageSquare className="msg-ico" />
        <span className="who">{spaceName}</span>
        <span className="t" title={approval.title}>
          {approval.title}
          <span>{text.split("\n")[0]}</span>
        </span>
        <div className="acts">
          {folded && (
            <button className="btn" data-act="open" aria-expanded onClick={() => setOpen(false)}>
              Hide
            </button>
          )}
          <button className="btn" disabled={busy !== null} onClick={() => void decline()}>
            Don't send
          </button>
        </div>
      </div>
      <div className="detail msg-card">
        {action.lastError && <p className="err last-try">Last try failed: {action.lastError}</p>}
        {needsPane(action.lastError) && settingsButton}
        <p className="msg-to">
          <span className="lbl">To</span>
          <b>{action.toName}</b>
          <span className="sep">·</span>
          {shown ? <span className="mono">{shown}</span> : <span className="need">number needed</span>}
          {source && (
            <>
              <span className="sep">·</span>
              <span className="faint">{source}</span>
            </>
          )}
        </p>
        <div className="msg-handle">
          <input
            className="mk-input"
            value={handle}
            spellCheck={false}
            autoComplete="off"
            placeholder="Phone number or email"
            aria-label="Phone number or email"
            readOnly={busy === "send"}
            onKeyDown={(e) => onNumberKey(e, () => busy === null && void lookup())}
            onChange={(e) => {
              setHandle(e.target.value);
              setTouched(true);
              setError(null);
            }}
          />
          <button className="btn" type="button" disabled={busy !== null} onClick={() => void lookup()}>
            <Search />
            {busy === "lookup" ? "Looking…" : `Look up "${action.toName}" in Contacts`}
          </button>
        </div>
        {handleIssue && <span className="err">{handleIssue}</span>}
        {!action.contactsReady && !lookupError && candidates.length === 0 && (
          <p className="hint">The first lookup asks macOS whether Atrium may read Contacts. Atrium only looks when you press the button.</p>
        )}
        {found && <p className="hint">{found}</p>}
        {candidates.length > 1 && (
          <fieldset className="msg-picks">
            <legend>Who should get it?</legend>
            {candidates.map((c) => (
              <label key={`${c.personId}-${c.handle}`} className="inline">
                <input
                  type="radio"
                  name={`to-${action.id}`}
                  checked={shown === displayHandle(c.handle)}
                  onChange={() => {
                    setHandle(displayHandle(c.handle));
                    setTouched(true);
                  }}
                />
                {candidateLine(c)}
              </label>
            ))}
          </fieldset>
        )}
        {lookupError && <p className="err">{lookupError}</p>}
        {needsPane(lookupError) && !needsPane(action.lastError) && settingsButton}
        <label className="msg-text">
          <span className="lbl-row">
            Message
            <span className={`count${textLength(text) > MAX_TEXT ? " over" : ""}`}>
              {textLength(text)}/{MAX_TEXT}
            </span>
          </span>
          <textarea
            className="mk-input"
            value={text}
            readOnly={busy === "send"}
            rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
            onChange={(e) => setText(e.target.value)}
          />
          {textIssue && <span className="err">{textIssue}</span>}
        </label>
        <div className="msg-foot">
          <button className="btn p" disabled={!canSend} onClick={send}>
            {busy === "send" ? "Sending…" : "Send"}
          </button>
          <span className="via">
            <span className="lbl">Via</span>
            <span className="seg" role="group" aria-label="Send as">
              {(["iMessage", "SMS"] as const).map((v) => (
                <button key={v} type="button" aria-pressed={service === v} onClick={() => setService(v)}>
                  {v}
                </button>
              ))}
            </span>
          </span>
          <p className="faint">Sends from Messages on this Mac. Atrium can't confirm delivery.</p>
        </div>
        {firstSend && <p className="hint">The first send asks macOS whether Atrium may control Messages. Click OK, and it sends.</p>}
      </div>
      {error && <div className="row-err err">{error}</div>}
      {needsPane(error) && !needsPane(action.lastError) && <div className="row-err">{settingsButton}</div>}
    </div>
  );
}

// One line for a text in a list: who it's to and how it starts. Review opens the full card, where Send is.
export function FoldedText({ icon: Icon, spaceName, to, text, onOpen }: { icon: LucideIcon; spaceName: string; to: string; text: string; onOpen: () => void }) {
  return (
    <div className="entry msg-entry">
      <div className="item folded">
        <Icon className="msg-ico" />
        <span className="who">{spaceName}</span>
        <span className="t" title={`Text to ${to}`}>
          Text to {to}
          <span>{snippet(text)}</span>
        </span>
        <div className="acts">
          <button className="btn" data-act="open" aria-expanded={false} onClick={onOpen}>
            Review
          </button>
        </div>
      </div>
    </div>
  );
}
