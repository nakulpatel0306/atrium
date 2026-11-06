import { MessageSquare } from "lucide-react";
import type { MessageAction } from "../../engine/messaging/store";
import { useEngineState, useFetched } from "../api";
import { absolute, relative } from "../format";

export function sentLine(m: MessageAction): string {
  if (m.status === "sent") return `Sent to ${m.toName} · ${relative(m.sentAt ?? m.updatedAt)}`;
  if (m.status === "rejected") return "Not sent · you chose not to send it";
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

// Every text this space sent, failed to send, or Nakul chose not to send; newest first.
export function SentMessages({ spaceId }: { spaceId: string }) {
  const messages = useFetched<MessageAction[]>(`/api/spaces/${encodeURIComponent(spaceId)}/messages`, useEngineState());
  return <SentList messages={messages ?? []} />;
}
