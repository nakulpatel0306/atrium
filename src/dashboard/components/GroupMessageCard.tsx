import { Search, Settings2, Split, Users } from "lucide-react";
import { useState } from "react";
import { groupTitle, MAX_TEXT, memberNames, textLength, textProblem } from "../../engine/messaging/rules";
import type { GroupChat } from "../../engine/messaging/store";
import { post, type State } from "../api";

type Approval = State["approvals"][number];
type Action = State["messageActions"][number];
type Found = { chats: GroupChat[]; picked: string | null; message: string | null };

// One line per chat Find listed: its name and who's in it, so two chats with the same people can be told apart.
export const chatLine = (c: GroupChat) => `${c.name ?? "Unnamed group"} · ${c.participants.map((p) => p.name ?? p.handle).join(", ")}`;

// A group text waiting to go. It sends only to an existing chat that Nakul's own Find picked, exactly the words shown,
// and only on his Send. With no chat, it can become one text per person, each still waiting for its own Send.
export function GroupMessageCard({ approval, action, spaceName = "Messages", firstSend = false }: { approval: Approval; action: Action; spaceName?: string; firstSend?: boolean }) {
  const group = action.group!;
  const [text, setText] = useState(action.text);
  const [chats, setChats] = useState<GroupChat[]>([]);
  const [found, setFound] = useState<string | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "decline" | "find" | "pick" | "apart" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chat = group.chat;
  const title = groupTitle(action.toName, group);
  const people = memberNames(group);
  const canApart = group.people.length > 0 || !!chat?.participants.some((p) => p.name);
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
  const send = () => canSend && void act("send", `/api/message-actions/${action.id}/send`, { text, chatId: chat?.id });
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

  return (
    <div className="entry msg-entry">
      <div className="item">
        <Users className="msg-ico" />
        <span className="who">{spaceName}</span>
        <span className="t" title={`Send a text to ${title}?`}>
          Send a text to {title}?<span>{text.split("\n")[0]}</span>
        </span>
        <div className="acts">
          <button className="btn" disabled={busy !== null} onClick={decline}>
            Don't send
          </button>
          <button className="btn p" disabled={!canSend} onClick={send}>
            {busy === "send" ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
      <form
        className="detail msg-card"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {action.lastError && <p className="err last-try">Last try failed: {action.lastError}</p>}
        {needsPane(action.lastError) && settingsButton}
        <p className="msg-to">
          <span className="lbl">To</span>
          <b>{title}</b>
          <span className="sep">·</span>
          {chat ? <span className="faint">group chat in Messages</span> : <span className="need">group chat needed</span>}
        </p>
        <p className="msg-to">
          <span className="lbl">People</span>
          {people.length ? <span>{people.join(", ")}</span> : <span className="faint">not known until you find the chat</span>}
          {chat && <span className="faint">({chat.participants.length})</span>}
        </p>
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
          <p className="hint">
            Find reads only your Messages chat names and who's in them, never what was said, and only when you press it.
            {canApart ? " Send separately makes one text per person, and each still waits for your Send." : ""}
          </p>
        )}
        {found && <p className="hint">{found}</p>}
        {chats.length > 0 && (
          <fieldset className="msg-picks">
            <legend>Which group chat?</legend>
            {chats.map((c) => (
              <label key={c.id} className="inline">
                <input type="radio" name={`chat-${action.id}`} checked={chat?.id === c.id} disabled={busy !== null} onChange={() => pick(c.id)} />
                {chatLine(c)}
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
          <textarea className="mk-input" value={text} rows={Math.min(8, Math.max(3, text.split("\n").length + 1))} onChange={(e) => setText(e.target.value)} />
          {textIssue && <span className="err">{textIssue}</span>}
        </label>
        <div className="msg-foot">
          <span className="via">
            <span className="lbl">Via</span>
            <span>{action.service}</span>
          </span>
          <p className="faint">Sends to the existing group chat from Messages on this Mac. Atrium can't confirm delivery.</p>
        </div>
        {firstSend && <p className="hint">The first send asks macOS whether Atrium may control Messages. Click OK, and it sends.</p>}
        <button type="submit" hidden />
      </form>
      {error && <div className="row-err err">{error}</div>}
      {needsPane(error) && !needsPane(action.lastError) && <div className="row-err">{settingsButton}</div>}
    </div>
  );
}
