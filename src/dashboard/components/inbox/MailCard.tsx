import { Mail, Paperclip } from "lucide-react";
import { useState } from "react";
import { bodyProblem, KIND_NOUN, namesLine, parseRecipients, personLabel, type Recipient, subjectProblem } from "../../../engine/mail/compose";
import { post, type State } from "../../api";
import { bytes } from "../../format";
import { useMailOverview } from "../../mail";
import { cancelSend, clearSendError, pendingSendOf, startSend, usePendingSend, useSendError } from "../../pending-send";

type Approval = State["approvals"][number];
export type MailActionView = State["mailActions"][number];

export const peopleText = (people: { name: string; address: string }[]) => people.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(", ");

// The notes that make a draft need the user's explicit Send, and the people Claude added. Both stay on the card, so
// the Send that follows has seen them.
export function SendNotes({ action, people }: { action: MailActionView; people: { address: string; name: string }[] }) {
  const marked = new Set([...action.to, ...action.cc, ...(action.event?.attendees ?? [])].filter((p) => p.added).map((p) => p.address));
  const added = people.filter((p) => marked.has(p.address.toLowerCase()));
  if (!action.reasons.length && !added.length) return null;
  return (
    <div className="mail-notes">
      {action.reasons.length > 0 && <span className="tag warn">Needs your Send</span>}
      <ul>
        {action.reasons.map((r) => (
          <li key={r.text}>{r.text}</li>
        ))}
        {added.length > 0 && (
          <li>
            <span className="tag">Added by Claude</span> {added.map(personLabel).join(", ")}
          </li>
        )}
      </ul>
    </div>
  );
}

// One line for a draft in a list. Review opens the full card, where Send is.
export function FoldedDraft({ title, line, onOpen }: { title: string; line: string; onOpen(): void }) {
  return (
    <div className="entry msg-entry">
      <div className="item folded">
        <Mail className="msg-ico" />
        <span className="who">Inbox</span>
        <span className="t" title={title}>
          {title}
          <span>{line}</span>
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

// An email waiting to go. What the user sees here is exactly what goes out: From, every person, the subject, his
// words and, below them, the quoted or forwarded message. His edits and his Send land together, and nothing else can
// send it.
export function MailCard({ approval, action, folded = false }: { approval: Approval; action: MailActionView; folded?: boolean }) {
  const overview = useMailOverview();
  const [held] = useState(() => pendingSendOf(action.id));
  const pending = usePendingSend(action.id);
  const locked = pending !== null || action.status === "saving";
  const sendError = useSendError(action.id);
  const [open, setOpen] = useState(!folded || !!action.lastError || !!held);
  const [accountId, setAccountId] = useState((held?.body.accountId as string | undefined) ?? action.accountId ?? "");
  const [to, setTo] = useState(held ? peopleText(held.body.to as Recipient[]) : peopleText(action.to));
  const [cc, setCc] = useState(held ? peopleText(held.body.cc as Recipient[]) : peopleText(action.cc));
  const [subject, setSubject] = useState((held?.body.subject as string | undefined) ?? action.subject);
  const [body, setBody] = useState((held?.body.body as string | undefined) ?? action.body);
  const [busy, setBusy] = useState<"save" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toP = parseRecipients(to);
  const ccP = parseRecipients(cc);
  const bodyIssue = body.trim() ? bodyProblem(body, action.kind) : null;
  const subjectIssue = action.kind === "new" ? subjectProblem(subject) : null;
  const accounts = (overview?.accounts ?? []).filter((a) => a.preferred && a.enabled);
  // The picker shows exactly the account the card holds; one it can't send from shows as unpicked.
  const fromOk = accounts.some((a) => a.id === accountId);
  const ready = !toP.problem && !ccP.problem && toP.people.length > 0 && !bodyProblem(body, action.kind) && !subjectIssue && fromOk;
  const canSend = ready && !locked && busy === null;
  const fields = () => ({ accountId, to: toP.people, cc: ccP.people, subject, body });
  const edited = () => {
    setError(null);
    clearSendError(action.id);
  };

  const send = () => {
    if (!canSend) return;
    setError(null);
    startSend(action.id, namesLine(toP.people), { ...fields(), seen: action.reasons.map((r) => r.key) }, `/api/mail/actions/${action.id}/send`);
  };
  const saveDraft = async () => {
    setBusy("save");
    const res = await post(`/api/mail/actions/${action.id}/save-draft`, fields());
    setBusy(null);
    if (!res.ok) setError(res.error);
  };
  const decline = async () => {
    setBusy("decline");
    const res = await post(`/api/approvals/${approval.id}`, { decision: "reject" });
    if (!res.ok) {
      setError(res.error);
      setBusy(null);
    }
  };

  if (!open) return <FoldedDraft title={approval.title} line={body.split("\n")[0] || action.subject} onOpen={() => setOpen(true)} />;

  return (
    <div className="entry msg-entry mail-card-entry" data-draft-id={action.id}>
      <div className="item">
        <Mail className="msg-ico" />
        <span className="who">Inbox</span>
        <span className="t" title={approval.title}>
          {approval.title}
          <span>{action.draftedBy === "claude" ? "Drafted by Claude" : `Your ${KIND_NOUN[action.kind]}`}</span>
        </span>
        <div className="acts">
          {folded && (
            <button className="btn" data-act="open" aria-expanded onClick={() => setOpen(false)}>
              Hide
            </button>
          )}
          <button className="btn" disabled={busy !== null || locked} onClick={() => void decline()}>
            Don't send
          </button>
        </div>
      </div>
      <div className="detail msg-card mail-card">
        {action.lastError && <p className="err last-try">Last try failed: {action.lastError}</p>}
        <SendNotes action={action} people={[...toP.people, ...ccP.people]} />
        <label className="mail-field">
          <span className="lbl">From</span>
          <select className="mk-input" value={fromOk ? accountId : ""} disabled={locked} onChange={(e) => (setAccountId(e.target.value), edited())}>
            {!fromOk && (
              <option value="" disabled>
                Pick an account
              </option>
            )}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.address}
              </option>
            ))}
          </select>
        </label>
        <label className="mail-field">
          <span className="lbl">To</span>
          <input className="mk-input" value={to} readOnly={locked} spellCheck={false} autoComplete="off" placeholder="name@example.com" onChange={(e) => (setTo(e.target.value), edited())} />
        </label>
        {toP.problem && <span className="err">{toP.problem}</span>}
        <label className="mail-field">
          <span className="lbl">Cc</span>
          <input className="mk-input" value={cc} readOnly={locked} spellCheck={false} autoComplete="off" onChange={(e) => (setCc(e.target.value), edited())} />
        </label>
        {ccP.problem && <span className="err">{ccP.problem}</span>}
        <label className="mail-field">
          <span className="lbl">Subject</span>
          <input
            className="mk-input"
            value={subject}
            readOnly={locked || action.kind !== "new"}
            title={action.kind !== "new" ? "A reply keeps the thread's subject, so it stays in the same thread." : undefined}
            onChange={(e) => (setSubject(e.target.value), edited())}
          />
        </label>
        {subjectIssue && <span className="err">{subjectIssue}</span>}
        <label className="msg-text">
          <span className="lbl-row">Message</span>
          <textarea className="mk-input" value={body} readOnly={locked} rows={Math.min(14, Math.max(4, body.split("\n").length + 1))} onChange={(e) => (setBody(e.target.value), edited())} />
          {bodyIssue && <span className="err">{bodyIssue}</span>}
        </label>
        {action.quoted && (
          <div className="mail-quoted-out">
            <span className="lbl">{action.kind === "forward" ? "Forwarded below your words" : "Quoted below your words"}</span>
            <pre>{action.quoted}</pre>
          </div>
        )}
        {action.attachments.length > 0 && (
          <ul className="mail-atts" aria-label="Attachments sent with it">
            {action.attachments.map((a) => (
              <li key={a.index} className="mail-att">
                <Paperclip aria-hidden />
                <span className="mail-att-name">{a.name}</span>
                <span className="faint">{bytes(a.size)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="msg-foot">
          {pending ? (
            <>
              <span className="sending">Sending…</span>
              {!pending.sending && (
                <button className="btn" onClick={() => cancelSend(action.id)}>
                  Undo
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn p" disabled={!canSend} onClick={send}>
                Send
              </button>
              <button className="btn" disabled={!ready || locked || busy !== null} onClick={() => void saveDraft()}>
                {busy === "save" || action.status === "saving" ? "Saving…" : "Save as draft"}
              </button>
            </>
          )}
          <p className="faint">Sends from {accounts.find((a) => a.id === accountId)?.address ?? "your account"} through its own mail app or Google. Save as draft puts it in that account's Drafts instead.</p>
        </div>
      </div>
      {(error ?? sendError) && (
        <div className="row-err err" role="alert">
          {error ?? sendError}
        </div>
      )}
    </div>
  );
}
