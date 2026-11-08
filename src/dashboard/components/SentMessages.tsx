import { MessageSquare } from "lucide-react";
import { groupTitle } from "../../engine/messaging/rules";
import type { MessageAction } from "../../engine/messaging/store";
import { useEngineState, useFetched } from "../api";
import { absolute, relative } from "../format";

export function sentLine(m: MessageAction): string {
  const to = m.group ? groupTitle(m.toName, m.group) : m.toName;
  const size = m.group?.chat ? ` (${m.group.chat.participants.length} people)` : "";
  if (m.status === "sent") return `Sent to ${to}${size} · ${relative(m.sentAt ?? m.updatedAt)}`;
  if (m.status === "rejected") return "Not sent · you chose not to send it";
  if (m.status === "split") return `Split into one text per person · ${to}`;
  return `Didn't send · ${m.error ?? "Atrium couldn't tell why."}`;
}

export function SentList({ messages }: { messages: MessageAction[] }) {
  if (messages.length === 0) return null;
  return (
    <>
      <h2>
        <MessageSquare />
        Texts
      </h2>
      <div className="list sent-list">
        {messages.map((m) => (
          <div key={m.id} className={`item sent ${m.status}`} title={absolute(m.updatedAt)}>
            <span className="t">
              {sentLine(m)}
              <span>{m.text.split("\n")[0]}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

// Every text this space sent, failed to send, split into one per person, or Nakul chose not to send; newest first.
export function SentMessages({ spaceId }: { spaceId: string }) {
  const messages = useFetched<MessageAction[]>(`/api/spaces/${encodeURIComponent(spaceId)}/messages`, useEngineState());
  return <SentList messages={messages ?? []} />;
}
