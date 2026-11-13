import { ArrowLeft, FileSearch, Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { post } from "../../api";
import { absolute, bytes } from "../../format";
import { type MessageView, personName, splitQuoted, useThread } from "../../mail";

function Attachment({ messageId, index, name, size, openable }: { messageId: string; index: number; name: string; size: number; openable: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async (how: "open" | "reveal") => {
    setBusy(true);
    const res = await post(`/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${index}/open`, { how });
    setBusy(false);
    setError(res.ok ? null : res.error);
  };
  return (
    <li className="mail-att">
      <Paperclip aria-hidden />
      <span className="mail-att-name">{name}</span>
      <span className="faint">{bytes(size)}</span>
      {openable && (
        <button className="btn" disabled={busy} onClick={() => void open("open")}>
          Open
        </button>
      )}
      <button className="btn" disabled={busy} onClick={() => void open("reveal")} aria-label={`Show ${name} in Finder`}>
        <FileSearch />
        Show in Finder
      </button>
      {error && <span className="err">{error}</span>}
    </li>
  );
}

// One message of the chain. Its body is plain text the engine made; quoted history is folded away.
function Message({ m, last, loading }: { m: MessageView; last: boolean; loading: boolean }) {
  const [expanded, setExpanded] = useState(last);
  const parts = m.body !== null ? splitQuoted(m.body) : null;
  return (
    <article className={`mail-msg${expanded ? " open" : ""}`} aria-label={`From ${personName(m.from)}, ${absolute(m.date)}`}>
      <button className="mail-msg-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="mail-from">{personName(m.from)}</span>
        {m.from.name && <span className="faint mail-addr">{m.from.address}</span>}
        <span className="mail-date faint">{absolute(m.date)}</span>
      </button>
      {!expanded ? (
        <p className="mail-snippet">{m.snippet}</p>
      ) : (
        <>
          <p className="mail-to faint">
            To {m.to.map(personName).join(", ") || "no one listed"}
            {m.cc.length > 0 && ` · Cc ${m.cc.map(personName).join(", ")}`}
          </p>
          {parts ? (
            <div className="mail-body">
              {parts.body}
              {parts.quoted && (
                <details className="mail-quoted">
                  <summary>Show quoted text</summary>
                  {parts.quoted}
                </details>
              )}
            </div>
          ) : (
            <p className="mail-body faint">{loading ? "Loading the message…" : m.snippet || "Atrium couldn't load this message's text yet."}</p>
          )}
          {m.attachments.length > 0 && (
            <ul className="mail-atts" aria-label="Attachments">
              {m.attachments.map((a, i) => (
                <Attachment key={`${a.name}-${i}`} messageId={m.id} index={i} name={a.name} size={a.size} openable={a.openable} />
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

// The chain, oldest first. Nothing in it loads from the web: bodies are text and attachments open only on request.
export function ThreadView({ id, onBack }: { id: string; onBack(): void }) {
  const detail = useThread(id);
  const head = useRef<HTMLHeadingElement>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Bodies are fetched once per opening, not on every refresh of the view.
  useEffect(() => {
    void post(`/api/mail/threads/${encodeURIComponent(id)}/open`, {});
  }, [id]);
  const retry = async () => {
    const res = await post(`/api/mail/threads/${encodeURIComponent(id)}/open`, { retry: true });
    setRetryError(res.ok ? null : res.error);
  };
  useEffect(() => {
    if (detail?.thread.id === id) head.current?.focus();
  }, [detail?.thread.id, id]);
  if (!detail) return <div className="thread-none">Loading the thread…</div>;
  const { thread, messages, loading, problem } = detail;
  return (
    <div className="thread">
      <button className="btn link thread-back" onClick={onBack}>
        <ArrowLeft />
        Inbox
      </button>
      <h2 className="thread-title" tabIndex={-1} ref={head}>
        {thread.subject || "(no subject)"}
      </h2>
      <p className="faint thread-meta">
        <span className="acct-dot" style={{ background: thread.account.color }} aria-hidden /> {thread.account.address} · {messages.length === 1 ? "1 message" : `${messages.length} messages`}
      </p>
      {(problem || retryError) && !loading && (
        <p className="err thread-problem" role="alert">
          {retryError ?? problem}{" "}
          <button className="btn" onClick={() => void retry()}>
            Retry
          </button>
        </p>
      )}
      {messages.map((m, i) => (
        <Message key={m.id} m={m} last={i === messages.length - 1} loading={loading && m.body === null} />
      ))}
    </div>
  );
}
