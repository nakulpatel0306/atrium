import { Paperclip } from "lucide-react";
import { useState } from "react";
import { bodyProblem, namesLine, parseRecipients, type Recipient, subjectProblem } from "../../../engine/mail/compose";
import { post, type State } from "../../api";
import { bytes } from "../../format";
import { announce } from "../../live";
import { useMailOverview } from "../../mail";
import { clearSendError, pendingSendOf, startSend, usePendingSend } from "../../pending-send";
import { DraftShell, type MailActionView, peopleText } from "./DraftShell";

type Approval = State["approvals"][number];

// An email waiting to go. What the user sees here is exactly what goes out: From, every person, the subject, his
// words and, below them, the quoted or forwarded message. A Google account sends from here, through the tray and its
// Undo; a Mail.app account opens the message in Mail, where the user sends it himself.
export function MailCard({ approval, action, folded = false }: { approval: Approval; action: MailActionView; folded?: boolean }) {
  const overview = useMailOverview();
  const [held] = useState(() => pendingSendOf(action.id));
  const locked = usePendingSend(action.id) !== null || action.status === "saving";
  const [accountId, setAccountId] = useState((held?.body.accountId as string | undefined) ?? action.accountId ?? "");
  const [to, setTo] = useState(held ? peopleText(held.body.to as Recipient[]) : peopleText(action.to));
  const [cc, setCc] = useState(held ? peopleText(held.body.cc as Recipient[]) : peopleText(action.cc));
  const [subject, setSubject] = useState((held?.body.subject as string | undefined) ?? action.subject);
  const [body, setBody] = useState((held?.body.body as string | undefined) ?? action.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toP = parseRecipients(to);
  const ccP = parseRecipients(cc);
  const bodyIssue = body.trim() ? bodyProblem(body, action.kind) : null;
  const subjectIssue = action.kind === "new" ? subjectProblem(subject) : null;
  const accounts = (overview?.accounts ?? []).filter((a) => a.preferred && a.enabled);
  // The picker shows exactly the account the card holds; one it can't send from shows as unpicked.
  const from = accounts.find((a) => a.id === accountId);
  const ready = !!from && !toP.problem && !ccP.problem && toP.people.length > 0 && !bodyProblem(body, action.kind) && !subjectIssue && !locked && !busy;
  const fields = () => ({ accountId, to: toP.people, cc: ccP.people, subject, body });
  const edited = (fn: () => void) => {
    fn();
    setError(null);
    clearSendError(action.id);
  };

  const run = async (path: string, done: string) => {
    setBusy(true);
    const res = await post(path, fields());
    setBusy(false);
    if (res.ok) announce(done);
    else setError(res.error);
  };
  const primary =
    from?.source === "apple"
      ? { label: "Open in Mail", disabled: !ready, onPress: () => void run(`/api/mail/actions/${action.id}/open-in-mail`, "Opened in Mail. Send it from there.") }
      : {
          label: "Send",
          disabled: !ready,
          onPress: () => startSend(action.id, namesLine(toP.people), { ...fields(), seen: action.reasons.map((r) => r.key) }, `/api/mail/actions/${action.id}/send`),
        };
  const secondary = from?.source === "google" ? { label: busy ? "Saving…" : "Save as draft", disabled: !ready, onPress: () => void run(`/api/mail/actions/${action.id}/save-draft`, "Saved to Gmail Drafts.") } : undefined;

  return (
    <DraftShell approval={approval} action={action} folded={folded} people={[...toP.people, ...ccP.people]} primary={primary} secondary={secondary} error={error}>
      <label className="mail-field">
        <span className="lbl">From</span>
        <select className="mk-input" value={from ? accountId : ""} disabled={locked} onChange={(e) => edited(() => setAccountId(e.target.value))}>
          {!from && (
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
        <input className="mk-input" value={to} readOnly={locked} spellCheck={false} autoComplete="off" placeholder="name@example.com" onChange={(e) => edited(() => setTo(e.target.value))} />
      </label>
      {toP.problem && <span className="err">{toP.problem}</span>}
      <label className="mail-field">
        <span className="lbl">Cc</span>
        <input className="mk-input" value={cc} readOnly={locked} spellCheck={false} autoComplete="off" onChange={(e) => edited(() => setCc(e.target.value))} />
      </label>
      {ccP.problem && <span className="err">{ccP.problem}</span>}
      <label className="mail-field">
        <span className="lbl">Subject</span>
        <input
          className="mk-input"
          value={subject}
          readOnly={locked || action.kind !== "new"}
          title={action.kind !== "new" ? "A reply keeps the thread's subject, so it stays in the same thread." : undefined}
          onChange={(e) => edited(() => setSubject(e.target.value))}
        />
      </label>
      {subjectIssue && <span className="err">{subjectIssue}</span>}
      <label className="msg-text">
        <span className="lbl-row">Message</span>
        <textarea className="mk-input" value={body} readOnly={locked} rows={Math.min(14, Math.max(4, body.split("\n").length + 1))} onChange={(e) => edited(() => setBody(e.target.value))} />
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
    </DraftShell>
  );
}
