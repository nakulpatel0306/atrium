import { ArrowRight, MessagesSquare } from "lucide-react";
import { agentName, verdictOf } from "../agents";
import { useMessages } from "../api";
import { absolute, clock } from "../format";
import { Avatar } from "./Avatar";

export function Thread({ taskId }: { taskId: string }) {
  const messages = useMessages(taskId);
  if (!messages?.length) return null;
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
              <div className="body">{m.body}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
