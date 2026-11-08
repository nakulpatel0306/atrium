// Carries out what a key asked for against the engine, and says what happened in the dashboard's words.
import { agentName } from "../dashboard/agents";
import type { PostResult } from "../dashboard/api";
import type { State } from "../engine/state";
import type { EngineClient } from "./client";
import type { Intent } from "./keys";
import type { Flash, Overlay } from "./ui";
import { homedir } from "node:os";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

// `spaceId` is set after a new space is set up, so the app can select it; `overlay` opens a confirm (an import's).
export type Outcome = Flash & { spaceId?: string; overlay?: Overlay };

const MAX_CSV_BYTES = 2 * 1024 * 1024;
type Preview = { format: "bank" | "wealthsimple" | "unknown"; bank: { label: string }; accounts: string[]; account: string | null; total: number; skipped: unknown[]; warnings: string[] };

// Reads the file on this Mac; the engine's preview route does the parsing and masking, as for the dashboard.
async function previewImport(client: EngineClient, spaceId: string, path: string): Promise<Outcome> {
  // A dragged-in path arrives quoted, or with shell escapes before spaces, brackets, quotes and the like.
  const trimmed = path.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  const full = (quoted ? quoted[2]! : trimmed.replace(/\\(.)/g, "$1")).replace(/^~(?=\/|$)/, homedir());
  const file = Bun.file(full);
  if (!(await file.exists())) return { tone: "bad", text: `There's no file at ${path.trim()}. Check the path, or drag the file into the terminal to paste it.` };
  if (file.size > MAX_CSV_BYTES) return { tone: "bad", text: "That file is over 2 MB; export a shorter date range." };
  let csv: string;
  try {
    csv = await file.text();
  } catch {
    return { tone: "bad", text: "Atrium couldn't read that file. Check that it's a CSV you can open." };
  }
  const res = await client.post<Preview>(`/api/investing/${encodeURIComponent(spaceId)}/money/preview`, { csv });
  if (!res.ok) return { tone: "bad", text: res.error };
  const p = res.data;
  if (p.format === "unknown" || p.total === 0) {
    return { tone: "bad", text: `${p.warnings[0] ?? "Nothing in that file could be read."} Import it from the dashboard's Money tab, where you can pick the columns.` };
  }
  const account = p.account ?? p.accounts[0] ?? "";
  const summary = [
    `${p.bank.label} · ${p.total} ${p.total === 1 ? "row" : "rows"}${p.skipped.length ? ` · ${p.skipped.length} skipped` : ""}`,
    p.account !== null ? `Into ${p.account}. Change the account on the dashboard if that's wrong.` : `Accounts: ${p.accounts.join(", ")}`,
    ...p.warnings,
  ];
  return { tone: "info", text: "Check what's in the file, then press y to import it.", overlay: { kind: "confirm", purpose: "import", targetId: spaceId, csv, account, summary } };
}

const ALREADY_HANDLED = "Already handled";

function said<T>(res: PostResult<T>, ok: (data: T) => string): Outcome {
  if (!res.ok) {
    return { tone: "bad", text: res.error === ALREADY_HANDLED ? "Already handled. It was decided somewhere else." : res.error };
  }
  return { tone: "ok", text: ok(res.data) };
}

// What became of a text after "Sending…": read from the engine's own activity rows once they arrive.
export function sendFollowUp(state: State, pending: { toName: string; at: number }): Flash | null {
  for (const row of state.activity) {
    if (row.createdAt < pending.at) continue;
    if (row.message.startsWith(`Sent via Messages to ${pending.toName} (`) || row.message.startsWith(`Sent a text to ${pending.toName} (`)) return { tone: "ok", text: `Sent to ${pending.toName}. Atrium can't confirm delivery.` };
    if (row.message.startsWith(`Couldn't send the text to ${pending.toName}:`)) {
      return { tone: "bad", text: `Couldn't send the text to ${pending.toName}. It's back in Needs you with what went wrong.` };
    }
  }
  return null;
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
    case "send_message": {
      // Exactly the text, number and service the confirm showed: what the engine has stored for this draft.
      const text = state.messageActions.find((m) => m.id === intent.actionId);
      if (text?.group) {
        if (!intent.chatId) return { tone: "bad", text: "Find the group chat on the dashboard first." };
        const res = await client.post(`/api/message-actions/${enc(text.id)}/send`, { text: intent.text ?? text.text, chatId: intent.chatId });
        return said(res, () => `Sending to ${intent.toName}… If it doesn't go, the text comes back in Needs you.`);
      }
      if (!text?.handle) return { tone: "bad", text: "Pick who this goes to on the dashboard first." };
      const res = await client.post(`/api/message-actions/${enc(text.id)}/send`, { text: intent.text ?? text.text, handle: text.handle, service: text.service });
      return said(res, () => `Sending to ${intent.toName}… If it doesn't go, the text comes back in Needs you.`);
    }
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
      type Reply = { space: Space; tasks?: Task[]; messaging?: true } | { draft: { draft: { name: string } | null } } | { message: { toName: string } };
      const res = await client.post<Reply>("/api/command", { text: intent.text });
      if (!res.ok) return said(res, () => "");
      const data = res.data;
      // A new project is only a draft until Nakul approves it, so there's no space to select yet.
      if ("draft" in data) return said(res, () => `Drafted "${data.draft.draft?.name ?? "your project"}". It's waiting in Needs you.`);
      // A text with its words is a card on Home right away; one without waits for an agent to draft it.
      if ("message" in data) return said(res, () => `Drafted a text to ${data.message.toName}. It's waiting in Needs you.`);
      if (data.messaging) {
        const to = data.tasks?.[0]?.title.replace(/^Draft a text to /, "") ?? "them";
        return said(res, () => `Atrium is drafting a text to ${to}. It'll be in Needs you to send.`);
      }
      return { ...said(res, () => `Set up ${data.space.name}.`), spaceId: data.space.id };
    }
    case "stop":
      // The engine answers with the task as the stop left it, which isn't always stopped.
      return said(await client.post<Task>(`/api/tasks/${enc(intent.taskId)}/stop`), (t) => stopText(taskTitle(intent.taskId), t.status));
    case "dismissNudge":
      return said(await client.post(`/api/investing/${enc(intent.spaceId)}/money/nudges/${enc(intent.nudgeId)}/dismiss`), () => "Dismissed. It won't come back for this month.");
    case "explain":
      return said(await client.post(`/api/investing/${enc(intent.spaceId)}/money/explain`, { month: intent.month }), () => "Claude is explaining your month. The answer shows up here.");
    case "moneyAsk":
      return said(await client.post(`/api/investing/${enc(intent.spaceId)}/money/ask`, { question: intent.question }), () => "Claude is looking at your money. The answer shows up here.");
    case "budget":
      return said(await client.put(`/api/investing/${enc(intent.spaceId)}/money/budgets`, { category: intent.category, limit: intent.limit }), () =>
        intent.limit === null ? `No budget for ${intent.category} now.` : `${intent.category} budget set to CA$${intent.limit.toLocaleString("en-US")} a month.`,
      );
    case "importPreview":
      return previewImport(client, intent.spaceId, intent.path);
    case "importCsv": {
      const res = await client.post<{ added: number; duplicates: number }>(`/api/investing/${enc(intent.spaceId)}/money/import`, { csv: intent.csv, account: intent.account });
      return said(res, (d) => `Imported ${d.added} ${d.added === 1 ? "row" : "rows"}${d.duplicates ? `, skipped ${d.duplicates} already there` : ""}.`);
    }
    case "investAsk":
      return said(await client.post(`/api/investing/${enc(intent.spaceId)}/symbol/${enc(intent.key)}/ask`, { question: intent.question }), () => `Asked Claude about ${intent.key}. The answer lands in the Investing space.`);
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
      // An earlier Messages space joins the current one rather than coming back as a second; X then means that one.
      if (res.ok && res.data.id && res.data.id !== intent.spaceId) {
        return { tone: "ok", text: `Moved the earlier ${name} into your current one, so there's only one.`, spaceId: res.data.id };
      }
      return said(res, () => `Restored ${name}. Press X to archive it again.`);
    }
    case "deleteSpace": {
      const res = await client.del<{ name: string; message: string; kept: string[] }>(`/api/spaces/${enc(intent.spaceId)}`, { name: intent.name });
      return said(res, (d) => [d.message, ...d.kept.slice(0, 1)].join(" "));
    }
  }
}
