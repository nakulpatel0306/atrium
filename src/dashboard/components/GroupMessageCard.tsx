import { Search, Settings2, Split, Users } from "lucide-react";
import { useState } from "react";
import { askLine, groupTitle, MAX_TEXT, peopleLine, separatePlan, textLength, textProblem } from "../../engine/messaging/rules";
import type { GroupChat } from "../../engine/messaging/store";
import { post, type State } from "../api";
import { FoldedText } from "./MessageCard";
import { announce } from "../live";
import { sendWithUndo } from "../pending-send";

type Approval = State["approvals"][number];
type Action = State["messageActions"][number];
type Found = { chats: GroupChat[]; picked: string | null; message: string | null };

// Who's in a chat Find listed, on its own line under the chat's name, so a name can't pose as the member list.
export const chatMembers = (c: GroupChat) => c.participants.map((p) => p.name ?? p.handle).join(", ");

// A group text waiting to go. It sends only to an existing chat that Nakul's own Find picked, exactly the words shown,
// and only on his Send. With no chat, it can become one text per person, each still waiting for its own Send.
export function GroupMessageCard({ approval, action, spaceName = "Messages", firstSend = false, folded = false }: { approval: Approval; action: Action; spaceName?: string; firstSend?: boolean; folded?: boolean }) {
  const [open, setOpen] = useState(!folded || !!action.lastError);
  const group = action.group!;
  const [text, setText] = useState(action.text);
  const [chats, setChats] = useState<GroupChat[]>([]);
  const [found, setFound] = useState<string | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "decline" | "find" | "pick" | "apart" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chat = group.chat;
  const title = groupTitle(action.toName, group);
  const apartPlan = separatePlan(group);
  const canApart = apartPlan.people.length > 0;
  const textIssue = textProblem(text);
  const canSend = !busy && !textIssue && !!chat;

  const act = async (kind: NonNullable<typeof busy>, path: string, body: unknown, onError = setError) => {
    setBusy(kind);
    onError(null);
    const res = await post(path, body);
    // On success the card changes or leaves with the next state push.
    setBusy(null);
    if (!res.ok) onError(res.error);
    return res.ok;
  };
  const send = () => {
    if (!canSend || !chat) return;
    setBusy("send");
    setError(null);
    const body = { text, chatId: chat.id };
    sendWithUndo(
      title,
      async () => {
        const res = await post(`/api/message-actions/${action.id}/send`, body);
        if (res.ok) return announce(`Sent to ${title}.`);
        setError(res.error);
        setBusy(null);
        announce(`Didn't send to ${title}. ${res.error}`);
      },
      () => setBusy(null),
    );
  };
  const decline = () => void act("decline", `/api/approvals/${approval.id}`, { decision: "reject" });
  const apart = () => !textIssue && void act("apart", `/api/message-actions/${action.id}/separately`, { text });
  const pick = (chatId: string) => void act("pick", `/api/message-actions/${action.id}/chat`, { chatId }, setFindError);
  const find = async () => {
    setBusy("find");
    setFindError(null);
    setFound(null);
    const res = await post<Found>(`/api/message-actions/${action.id}/find-chat`);
    setBusy(null);
    if (!res.ok) return setFindError(res.error);
    setChats(res.data.chats);
    setFound(res.data.message);
  };
  const openSettings = async () => {
    const res = await post("/api/messaging/open-settings", { pane: "automation" });
    if (!res.ok) setFindError(res.error);
  };
  const needsPane = (msg: string | null) => !!msg && /System Settings/.test(msg);
  const settingsButton = (
    <button className="btn" type="button" onClick={() => void openSettings()}>
      <Settings2 />
      Open System Settings
    </button>
  );

  if (!open) return <FoldedText icon={Users} spaceName={spaceName} to={title} text={text} onOpen={() => setOpen(true)} />;

  return (
    <div className="entry msg-entry">
      <div className="item">
        <Users className="msg-ico" />
        <span className="who">{spaceName}</span>
        <span className="t" title={`Send a text to ${title}?`}>
          Send a text to {title}?<span>{text.split("\n")[0]}</span>
        </span>
        <div className="acts">
          {folded && (
            <button className="btn" data-act="open" aria-expanded onClick={() => setOpen(false)}>
              Hide
            </button>
          )}
          <button className="btn" disabled={busy !== null} onClick={decline}>
            Don't send
          </button>
        </div>
      </div>
      <div className="detail msg-card">
        {action.lastError && <p className="err last-try">Last try failed: {action.lastError}</p>}
        {needsPane(action.lastError) && settingsButton}
        <p className="msg-to">
          <span className="lbl">To</span>
          {chat ? (
            <>
              <b>{chat.name ?? "Unnamed group"}</b>
              <span className="faint">{chat.name ? "chat name from Messages" : "group chat in Messages"}</span>
            </>
          ) : (
            <>
              <b>{title}</b>
              <span className="sep">·</span>
              <span className="need">group chat needed</span>
            </>
          )}
        </p>
        <p className="msg-to">
          <span className="lbl">You asked for</span>
          <span>{askLine(group)}</span>
        </p>
        <div className="msg-members">
          <span className="lbl">{chat ? `In this chat (${chat.participants.length})` : "People"}</span>
          {chat ? (
            <ul>
              {chat.participants.map((p) => (
                <li key={p.handle + (p.name ?? "")}>
                  <b>{p.name ?? "No name in Contacts"}</b>
                  <span className="mono faint">{p.handle}</span>
                </li>
              ))}
            </ul>
          ) : group.people.length ? (
            <ul>
              {group.people.map((p) => (
                <li key={p}>
                  <b>{p}</b>
                </li>
              ))}
            </ul>
          ) : (
            <span className="faint">Not known until you find the chat.</span>
          )}
        </div>
        <div className="msg-handle">
          <button className="btn" type="button" disabled={busy !== null} onClick={() => void find()}>
            <Search />
            {busy === "find" ? "Looking…" : chat ? "Find a different group chat" : "Find group chat"}
          </button>
          {canApart && (
            <button className="btn" type="button" disabled={busy !== null || !!textIssue} onClick={apart}>
              <Split />
              {busy === "apart" ? "Splitting…" : "Send separately"}
            </button>
          )}
        </div>
        {!chat && chats.length === 0 && !findError && (
          <p className="hint">Find reads only your Messages chat names and who's in them, never what was said, and only when you press it.</p>
        )}
        {canApart && (
          <p className="hint">
            Send separately makes one text each for {peopleLine(apartPlan.people)}, and each still waits for your Send.
            {apartPlan.skipped.map((x) => ` Not included: ${x.who}. ${x.why}`).join("")}
          </p>
        )}
        {found && <p className="hint">{found}</p>}
        {chats.length > 0 && (
          <fieldset className="msg-picks">
            <legend>Which group chat?</legend>
            {chats.map((c) => (
              <label key={c.id} className="inline chat-pick">
                <input type="radio" name={`chat-${action.id}`} checked={chat?.id === c.id} disabled={busy !== null} onChange={() => pick(c.id)} />
                <span>
                  <span className="chat-name">{c.name ?? "Unnamed group"}</span>
                  <span className="chat-members">{chatMembers(c)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {findError && <p className="err">{findError}</p>}
        {needsPane(findError) && !needsPane(action.lastError) && settingsButton}
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
            <span>{action.service}</span>
          </span>
          <p className="faint">Sends to the existing group chat from Messages on this Mac. Atrium can't confirm delivery.</p>
        </div>
        {firstSend && <p className="hint">The first send asks macOS whether Atrium may control Messages. Click OK, and it sends.</p>}
      </div>
      {error && <div className="row-err err">{error}</div>}
      {needsPane(error) && !needsPane(action.lastError) && <div className="row-err">{settingsButton}</div>}
    </div>
  );
}
