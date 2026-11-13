import { PenLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { post, useEngineState } from "../../api";
import { showToast } from "../../toast";
import { type InboxFilter, type MailOverview, peopleLine, shortWhen, useThreads } from "../../mail";
import { DraftCard } from "./DraftCard";
import { startDraft, ThreadView } from "./ThreadView";

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "needs_reply", label: "Needs a reply" },
];

// The unified Inbox: account chips, filters, and the thread list beside the open thread. j/k move, Enter opens,
// Escape goes back to the list; with a thread open, r replies, a replies to all, f forwards and e archives (Google).
export function InboxList({ overview }: { overview: MailOverview }) {
  const [account, setAccount] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const threads = useThreads(account, filter);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = overview.accounts.filter((a) => a.preferred && a.enabled);
  const state = useEngineState();
  const [draftError, setDraftError] = useState<string | null>(null);
  // New emails have no thread, so their cards sit above the list.
  const newDrafts = (state?.mailActions ?? []).filter((m) => m.kind === "new");
  // e: Gmail archive, with an Undo toast that puts it back. Mail.app accounts archive in Mail.
  const archive = async (id: string, subject: string) => {
    const res = await post(`/api/mail/threads/${encodeURIComponent(id)}/archive`, {});
    if (!res.ok) return setDraftError(res.error);
    setDraftError(null);
    setOpen(null);
    showToast(`Archived "${subject || "(no subject)"}".`, () => post(`/api/mail/threads/${encodeURIComponent(id)}/archive`, { undo: true }));
  };
  const newEmail = async () => {
    const res = await post("/api/mail/drafts", { kind: "new", accountId: account ?? undefined });
    setDraftError(res.ok ? null : res.error);
  };

  useEffect(() => setCursor(0), [account, filter]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!threads?.length || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    // Keys pressed on a draft card's own buttons belong to that card.
    if (e.target instanceof Element && e.target.closest(".mail-card-entry")) return;
    const move = (to: number) => {
      const i = Math.max(0, Math.min(threads.length - 1, to));
      setCursor(i);
      rows.current[i]?.focus();
      e.preventDefault();
    };
    if (e.key === "j" || e.key === "ArrowDown") move(cursor + 1);
    else if (e.key === "k" || e.key === "ArrowUp") move(cursor - 1);
    else if (open && e.key === "e") {
      e.preventDefault();
      const thread = threads.find((t) => t.id === open);
      if (thread) void archive(thread.id, thread.subject);
    } else if (open && (e.key === "r" || e.key === "a" || e.key === "f")) {
      e.preventDefault();
      void startDraft(open, e.key === "r" ? "reply" : e.key === "a" ? "reply_all" : "forward", state?.mailActions ?? []).then(setDraftError);
    } else if (e.key === "Escape" && open) {
      setOpen(null);
      requestAnimationFrame(() => rows.current[cursor]?.focus());
    }
  };

  return (
    <div className={`inbox${open ? " has-open" : ""}`} onKeyDown={onKey}>
      <div className="inbox-filters">
        <div className="chips" role="group" aria-label="Accounts">
          <button className="chip" aria-pressed={account === null} onClick={() => setAccount(null)}>
            All accounts
          </button>
          {shown.map((a) => (
            <button key={a.id} className="chip" aria-pressed={account === a.id} onClick={() => setAccount(account === a.id ? null : a.id)}>
              <span className="acct-dot" style={{ background: a.color }} aria-hidden />
              {a.address}
            </button>
          ))}
        </div>
        <div className="chips" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <button className="btn new-email" onClick={() => void newEmail()}>
          <PenLine />
          New email
        </button>
        {draftError && (
          <span className="err" role="alert">
            {draftError}
          </span>
        )}
      </div>
      {newDrafts.map((d) => {
        const approval = state?.approvals.find((a) => a.id === d.approvalId);
        return approval ? <DraftCard key={d.id} approval={approval} action={d} /> : null;
      })}
      <div className="inbox-panes">
        <div className="list thread-list" role="list" aria-label="Threads">
          {threads === null ? (
            <div className="empty-row">Loading…</div>
          ) : threads.length === 0 ? (
            <div className="empty-row">{filter === "needs_reply" ? "Nothing waiting on a reply from you." : filter === "unread" ? "No unread mail." : "No mail in the sync window yet."}</div>
          ) : (
            threads.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => void (rows.current[i] = el)}
                role="listitem"
                className={`item thread-row${t.unread ? " unread" : ""}${open === t.id ? " on" : ""}`}
                aria-current={open === t.id ? "true" : undefined}
                tabIndex={i === cursor ? 0 : -1}
                onFocus={() => setCursor(i)}
                onClick={() => {
                  setCursor(i);
                  setOpen(t.id);
                }}
              >
                <span className="acct-dot" style={{ background: t.account.color }} title={t.account.address} aria-label={`Account ${t.account.address}`} />
                <span className="thread-main">
                  <span className="thread-top">
                    <span className="thread-who">
                      {peopleLine(t.participants)}
                      {t.count > 1 && <span className="thread-count">{t.count}</span>}
                    </span>
                    <span className="thread-when">{shortWhen(t.lastAt)}</span>
                  </span>
                  <span className="thread-subject">
                    {t.unread > 0 && <span className="sr-only">Unread. </span>}
                    {t.subject || "(no subject)"}
                    {t.needsReply && <span className="tag reply">Needs a reply</span>}
                  </span>
                  <span className="thread-snippet">{t.snippet}</span>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="thread-pane">
          {open ? (
            <ThreadView id={open} onBack={() => setOpen(null)} />
          ) : (
            <div className="thread-none">
              <p>Pick a thread to read it here.</p>
              <p className="hint">j and k move through the list, Enter opens. In a thread, r replies, a replies to all, f forwards, e archives.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
