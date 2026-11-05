import type { Database } from "bun:sqlite";
import { createApproval } from "../../src/engine/approvals";
import { createSpace } from "../../src/engine/spaces";
import { createTask, setTaskStatus } from "../../src/engine/tasks";

// A space with one task in review and its pending approval, as the runner would leave them.
export function seedReview(db: Database) {
  const space = createSpace(db, { name: "atrium", kind: "general", goal: "Ship the terminal app" });
  const task = createTask(db, { spaceId: space.id, title: "Fix login redirect" });
  setTaskStatus(db, task.id, "running");
  setTaskStatus(db, task.id, "review");
  const approval = createApproval(db, { spaceId: space.id, taskId: task.id, kind: "review", title: "Review: Fix login redirect", detail: "Changed 2 files." });
  return { space, task, approval };
}
