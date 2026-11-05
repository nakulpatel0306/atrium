import type { Database } from "bun:sqlite";
import { bus } from "./events";
import { newId } from "./ids";

// One line of the agent-to-agent thread about a task: a review request, a review, a fix, or why one didn't happen.
export type Message = {
  id: string;
  spaceId: string;
  taskId: string;
  fromAgent: string;
  toAgent: string;
  body: string;
  createdAt: number;
};

export function addMessage(db: Database, m: Omit<Message, "id" | "createdAt">): Message {
  const msg: Message = { id: newId("msg"), createdAt: Date.now(), ...m };
  db.query(
    "INSERT INTO messages (id, space_id, task_id, from_agent, to_agent, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(msg.id, msg.spaceId, msg.taskId, msg.fromAgent, msg.toAgent, msg.body, msg.createdAt);
  bus.emit({ type: "changed" });
  return msg;
}

export function listMessages(db: Database, taskId: string): Message[] {
  // rowid breaks ties between messages added in the same millisecond
  return db
    .query(
      `SELECT id, space_id AS spaceId, task_id AS taskId, from_agent AS fromAgent, to_agent AS toAgent, body, created_at AS createdAt
       FROM messages WHERE task_id = ? ORDER BY created_at, rowid`,
    )
    .all(taskId) as Message[];
}
