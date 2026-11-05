// Carries out what a key asked for against the engine, and says what happened in the dashboard's words.
import { agentName } from "../dashboard/agents";
import type { PostResult } from "../dashboard/api";
import type { State } from "../engine/state";
import type { EngineClient } from "./client";
import type { Intent } from "./keys";
import type { Flash } from "./ui";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

// `spaceId` is set after a new space is set up, so the app can select it.
export type Outcome = Flash & { spaceId?: string };

const ALREADY_HANDLED = "Already handled";

function said<T>(res: PostResult<T>, ok: (data: T) => string): Outcome {
  if (!res.ok) {
    return { tone: "bad", text: res.error === ALREADY_HANDLED ? "Already handled. It was decided somewhere else." : res.error };
  }
  return { tone: "ok", text: ok(res.data) };
}

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
      const res = await client.post<{ space: Space }>("/api/command", { text: intent.text });
      const out = said(res, (d) => `Set up ${d.space.name}.`);
      return res.ok ? { ...out, spaceId: res.data.space.id } : out;
    }
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
      const ok = intent.reviewBy ? `${agentName(intent.reviewBy)} reviews finished work in ${name}.` : `No automatic review in ${name}.`;
      return space(intent.spaceId, { reviewBy: intent.reviewBy }, ok);
    }
    case "archive":
      return space(intent.spaceId, { status: "archived" }, `Archived ${spaceName(intent.spaceId)}. Its agents stop picking up tasks.`);
  }
}
