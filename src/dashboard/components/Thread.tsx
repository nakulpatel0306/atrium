import { ArrowRight, MessagesSquare } from "lucide-react";
import { agentName, verdictOf } from "../agents";
import { type Message, useMessages } from "../api";
import { absolute, clock } from "../format";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";

export function Thread({ taskId }: { taskId: string }) {
  const messages = useMessages(taskId);
  return messages?.length ? <ThreadList messages={messages} /> : null;
}

export function ThreadList({ messages }: { messages: Message[] }) {
  return (
    <div className="thread">
      <h3>
        <MessagesSquare />
        Agent thread
      </h3>
      <ol>
        {messages.map((m) => {
          const verdict = verdictOf(m.body);
          return (
            <li key={m.id}>
              <div className="from">
                <Avatar agent={m.fromAgent} />
                <b>{agentName(m.fromAgent)}</b>
                <ArrowRight className="to" />
                {agentName(m.toAgent)}
                {verdict && (
                  <span className={`tag verdict ${verdict}`}>{verdict === "approve" ? "approves" : "asks for changes"}</span>
                )}
                <time title={absolute(m.createdAt)}>{clock(m.createdAt)}</time>
              </div>
              <Markdown className="body" text={m.body} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
