// Carries out what a key asked for against the engine, and says what happened in the dashboard's words.
import { agentName } from "../dashboard/agents";
import type { PostResult } from "../dashboard/api";
import type { State } from "../engine/state";
import type { EngineClient } from "./client";
import type { Intent } from "./keys";
import type { Flash, Overlay } from "./ui";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

// `spaceId` is set after a new space is set up, so the app can select it; `overlay` opens a confirm.
export type Outcome = Flash & { spaceId?: string; overlay?: Overlay };

const ALREADY_HANDLED = "Already handled";

function said<T>(res: PostResult<T>, ok: (data: T) => string): Outcome {
  if (!res.ok) {
    return { tone: "bad", text: res.error === ALREADY_HANDLED ? "Already handled. It was decided somewhere else." : res.error };
  }
  return { tone: "ok", text: ok(res.data) };
}

export const stopText = (title: string, status: Task["status"]) =>
  status === "blocked"
    ? `Stopped "${title}". Its edits so far are kept; R retries it.`
    : status === "running"
      ? `Stopping "${title}": the agent hasn't exited yet. Atrium marks it stopped when it does.`
      : `"${title}" finished before it could be stopped.`;

export async function runIntent(client: EngineClient, intent: Intent, state: State): Promise<Outcome> {
  const taskTitle = (id: string) => state.tasks.find((t) => t.id === id)?.title ?? "the task";
  const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? "the space";
  const space = (id: string, body: unknown, ok: string) =>
    client.patch(`/api/spaces/${encodeURIComponent(id)}`, body).then((res) => said(res, () => ok));
  const enc = encodeURIComponent;

  switch (intent.type) {
    case "approve":
      return said(await client.post(`/api/approvals/${enc(intent.approvalId)}`, { decision: "approve" }), () => `Approved "${intent.title}".`);
    case "reject": {
      const note = intent.note.trim();
      const res = await client.post(`/api/approvals/${enc(intent.approvalId)}`, { decision: "reject", ...(note ? { note } : {}) });
      return said(res, () => (note ? "Sent back with your note." : "Sent back."));
    }
    case "retry":
      return said(await client.post(`/api/tasks/${enc(intent.taskId)}/retry`), () => `Queued "${taskTitle(intent.taskId)}" again.`);
    case "runNow":
      return said(
        await client.post(`/api/tasks/${enc(intent.taskId)}/run-now`),
        () => `Starting "${taskTitle(intent.taskId)}" now, using Claude's reserved window.`,
      );
    case "newTask": {
      const res = await client.post<{ task: Task }>("/api/command", { text: intent.text, spaceId: intent.spaceId, agent: intent.agent });
      const by = intent.agent === "auto" ? "" : ` for ${agentName(intent.agent)}`;
      return said(res, (d) => `Queued "${d.task.title}" in ${spaceName(intent.spaceId)}${by}.`);
    }
    case "newSpace": {
      type Reply = { space: Space; tasks?: Task[] } | { draft: { draft: { name: string } | null } };
      const res = await client.post<Reply>("/api/command", { text: intent.text });
      if (!res.ok) return said(res, () => "");
      const data = res.data;
      // A new project is only a draft until Nakul approves it, so there's no space to select yet.
      if ("draft" in data) return said(res, () => `Drafted "${data.draft.draft?.name ?? "your project"}". It's waiting in Needs you.`);
      return { ...said(res, () => `Set up ${data.space.name}.`), spaceId: data.space.id };
    }
    case "stop":
      // The engine answers with the task as the stop left it, which isn't always stopped.
      return said(await client.post<Task>(`/api/tasks/${enc(intent.taskId)}/stop`), (t) => stopText(taskTitle(intent.taskId), t.status));
    case "setAgent":
      return said(
        await client.patch(`/api/tasks/${enc(intent.taskId)}`, { agent: intent.agent }),
        () => `${agentName(intent.agent)} will take "${taskTitle(intent.taskId)}".`,
      );
    case "overnight":
      return said(await client.post("/api/settings", { overnight: intent.on }), () =>
        intent.on
          ? "Overnight mode on. Leave the lid open; your Mac stays awake while plugged in and work is queued."
          : "Overnight mode off.",
      );
    case "reserve":
      return said(
        await client.post("/api/settings", { claudeReserve: intent.value }),
        () => `Claude tasks now pause at ${Math.round(intent.value * 100)}% of the window.`,
      );
    case "private": {
      const name = spaceName(intent.spaceId);
      return space(intent.spaceId, { private: intent.on }, intent.on ? `${name} is private now. Only Claude works here.` : `${name} is no longer private.`);
    }
    case "goal":
      return space(intent.spaceId, { goal: intent.goal }, "Goal saved.");
    case "reviewer": {
      const name = spaceName(intent.spaceId);
      const ok =
        intent.reviewBy === "off"
          ? `No review in ${name}: finished code comes to you once its checks pass.`
          : intent.reviewBy === "auto"
            ? `A fresh agent reviews finished code in ${name}.`
            : `${agentName(intent.reviewBy)} reviews finished code in ${name}.`;
      return space(intent.spaceId, { reviewBy: intent.reviewBy }, ok);
    }
    case "answer": {
      const proposal = state.proposals.find((p) => p.id === intent.proposalId);
      const name = proposal ? spaceName(proposal.spaceId) : "this space";
      const res = await client.post(`/api/proposals/${enc(intent.proposalId)}`, { answer: intent.answer });
      return said(res, () =>
        intent.answer === "yes"
          ? `Atrium will approve ${intent.label} in ${name} on its own. Undo any of them, or turn the rule off, on the dashboard's Rules page.`
          : intent.answer === "not_now"
            ? `Not now. Atrium will keep asking about ${intent.label}.`
            : `Atrium won't suggest a rule for ${intent.label} again.`,
      );
    }
    case "openFile": {
      const res = await client.post<{ app: string }>(`/api/spaces/${enc(intent.spaceId)}/file/open`, { path: intent.path, how: intent.how });
      return said(res, (d) => (intent.how === "reveal" ? `Showing ${intent.name} in Finder.` : `Opened a copy of ${intent.name} in ${d.app}.`));
    }
    case "archive":
      return space(intent.spaceId, { status: "archived" }, `Archived ${spaceName(intent.spaceId)}. It's at the end of Spaces; press X there to restore it.`);
    case "restore": {
      const name = state.archived?.find((s) => s.id === intent.spaceId)?.name ?? "the space";
      const res = await client.patch<Space>(`/api/spaces/${enc(intent.spaceId)}`, { status: "active" });
      return said(res, () => `Restored ${name}. Press X to archive it again.`);
    }
    case "deleteSpace": {
      const res = await client.del<{ name: string; message: string; kept: string[] }>(`/api/spaces/${enc(intent.spaceId)}`, { name: intent.name });
      return said(res, (d) => [d.message, ...d.kept.slice(0, 1)].join(" "));
    }
  }
}
