import type { Database } from "bun:sqlite";
import { AlreadyResolved, type Approval, createApproval, getApproval } from "../approvals";
import { bus } from "../events";
import { newId } from "../ids";
import { BAD_HANDLE_COPY, displayHandle, nameProblem, normalizeHandle, oneLine, textProblem } from "./rules";

export type Candidate = { personId: string; name: string; kind: "phone" | "email"; label: string | null; handle: string };
export type Service = "iMessage" | "SMS";
export type HandleSource = "contacts" | "you" | "agent";

export type MessageAction = {
  id: string;
  approvalId: string;
  spaceId: string;
  taskId: string | null;
  toName: string;
  handle: string | null;
  handleSource: HandleSource | null;
  candidates: Candidate[] | null;
  service: Service;
  text: string;
  status: "draft" | "sending" | "sent" | "failed" | "rejected";
  // On a draft, why the previous try failed; on a failed action, why this one did.
  error: string | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type ActionRow = {
  id: string;
  approval_id: string;
  space_id: string;
  task_id: string | null;
  to_name: string;
  handle: string | null;
  handle_source: HandleSource | null;
  candidates: string | null;
  service: Service;
  text: string;
  status: MessageAction["status"];
  error: string | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
};

export class BadMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadMessage";
  }
}

const toAction = (r: ActionRow): MessageAction => ({
  id: r.id,
  approvalId: r.approval_id,
  spaceId: r.space_id,
  taskId: r.task_id,
  toName: r.to_name,
  handle: r.handle,
  handleSource: r.handle_source,
  candidates: r.candidates ? (JSON.parse(r.candidates) as Candidate[]) : null,
  service: r.service,
  text: r.text,
  status: r.status,
  error: r.error,
  sentAt: r.sent_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const getMessageAction = (db: Database, id: string): MessageAction | null => {
  const row = db.query("SELECT * FROM message_actions WHERE id = ?").get(id) as ActionRow | null;
  return row ? toAction(row) : null;
};

export const actionForApproval = (db: Database, approvalId: string): MessageAction | null => {
  const row = db.query("SELECT * FROM message_actions WHERE approval_id = ?").get(approvalId) as ActionRow | null;
  return row ? toAction(row) : null;
};

export const pendingMessageActions = (db: Database): MessageAction[] =>
  (
    db
      .query(
        `SELECT m.* FROM message_actions m JOIN approvals a ON a.id = m.approval_id
         WHERE m.status = 'draft' AND a.status = 'pending' ORDER BY m.created_at, m.rowid`,
      )
      .all() as ActionRow[]
  ).map(toAction);

export const messageHistory = (db: Database, spaceId: string): MessageAction[] =>
  (
    db.query("SELECT * FROM message_actions WHERE space_id = ? AND status != 'draft' ORDER BY updated_at DESC, rowid DESC").all(spaceId) as ActionRow[]
  ).map(toAction);

// What Nakul reads before he decides: who, how, the exact words, and what pressing Send does.
export function messageDetail(a: Pick<MessageAction, "toName" | "handle" | "service" | "text" | "error">): string {
  const lines: string[] = [];
  if (a.error) lines.push(`Last try failed: ${oneLine(a.error)}`);
  lines.push(`To: ${a.toName} · ${a.handle ? displayHandle(a.handle) : "number needed"}`, `Via: ${a.service}`, "");
  lines.push(...a.text.split("\n").map((l) => `> ${l}`));
  lines.push("", "On Send, Atrium sends exactly this from Messages on this Mac. It can't confirm delivery.");
  return lines.join("\n");
}

const titleFor = (toName: string) => `Send a text to ${toName}?`;

// A handle that doesn't pass the rules is left out, never an error: the card asks Nakul for one instead.
export function draftMessage(
  db: Database,
  input: {
    spaceId: string;
    taskId?: string | null;
    toName: string;
    text: string;
    handle?: string | null;
    handleSource?: HandleSource | null;
    service?: Service;
    lastError?: string;
  },
): { action: MessageAction; approval: Approval } {
  const problem = textProblem(input.text);
  if (problem) throw new BadMessage(problem);
  const badName = nameProblem(input.toName);
  if (badName) throw new BadMessage(badName);
  const toName = input.toName.trim();
  const handle = input.handle ? normalizeHandle(input.handle) : null;
  const fields = { toName, handle, service: input.service ?? "iMessage", text: input.text.trim(), error: input.lastError ? oneLine(input.lastError) : null } as const;
  const made = db.transaction(() => {
    const approval = createApproval(db, {
      spaceId: input.spaceId,
      taskId: input.taskId ?? undefined,
      kind: "question",
      title: titleFor(toName),
      detail: messageDetail(fields),
      alwaysAsk: "send_message",
    });
    const id = newId("msa");
    const now = Date.now();
    db.query(
      `INSERT INTO message_actions (id, approval_id, space_id, task_id, to_name, handle, handle_source, service, text, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(id, approval.id, input.spaceId, input.taskId ?? null, toName, handle, handle ? (input.handleSource ?? "you") : null, fields.service, fields.text, fields.error, now, now);
    return { action: getMessageAction(db, id)!, approval };
  })();
  bus.emit({ type: "changed" });
  return made;
}

// Only while Nakul hasn't decided: what he decides on is exactly what will be sent.
function draftOrThrow(db: Database, id: string): MessageAction {
  const action = getMessageAction(db, id);
  if (!action) throw new Error(`No message draft with id ${id}`);
  if (action.status !== "draft" || getApproval(db, action.approvalId)?.status !== "pending") throw new AlreadyResolved();
  return action;
}

function writeDraft(db: Database, action: MessageAction): void {
  db.query("UPDATE message_actions SET handle = ?, handle_source = ?, candidates = ?, service = ?, text = ?, updated_at = ? WHERE id = ? AND status = 'draft'").run(
    action.handle,
    action.handleSource,
    action.candidates ? JSON.stringify(action.candidates) : null,
    action.service,
    action.text,
    Date.now(),
    action.id,
  );
  db.query("UPDATE approvals SET detail = ? WHERE id = ? AND status = 'pending'").run(messageDetail(action), action.approvalId);
}

// Nakul's edits land on the draft and its approval together.
export function updateMessageDraft(db: Database, id: string, patch: { text: string; handle: string; service: Service }): MessageAction {
  const next = db.transaction(() => {
    const cur = draftOrThrow(db, id);
    const problem = textProblem(patch.text);
    if (problem) throw new BadMessage(problem);
    const handle = normalizeHandle(patch.handle);
    if (!handle) throw new BadMessage(BAD_HANDLE_COPY);
    if (patch.service !== "iMessage" && patch.service !== "SMS") throw new BadMessage("Send it as iMessage or SMS.");
    const source: HandleSource = cur.candidates?.some((c) => c.handle === handle)
      ? "contacts"
      : handle === cur.handle && cur.handleSource
        ? cur.handleSource
        : "you";
    writeDraft(db, { ...cur, handle, handleSource: source, service: patch.service, text: patch.text.trim() });
    return getMessageAction(db, id)!;
  })();
  bus.emit({ type: "changed" });
  return next;
}

// A lookup's matches, and the handle when exactly one came back.
export function setCandidates(db: Database, id: string, candidates: Candidate[], picked?: string | null): MessageAction {
  const next = db.transaction(() => {
    const cur = draftOrThrow(db, id);
    const handle = picked ? normalizeHandle(picked) : null;
    writeDraft(db, { ...cur, candidates, ...(handle ? { handle, handleSource: "contacts" as const } : {}) });
    return getMessageAction(db, id)!;
  })();
  bus.emit({ type: "changed" });
  return next;
}

const MOVES: Record<MessageAction["status"], MessageAction["status"][]> = {
  // Straight to failed only when the executor refuses to send at all.
  draft: ["sending", "rejected", "failed"],
  sending: ["sent", "failed"],
  sent: [],
  failed: [],
  rejected: [],
};

// Guarded on the status it read, so two callers racing to send the same draft can't both move it.
export function setMessageStatus(db: Database, id: string, to: MessageAction["status"], patch: { error?: string; sentAt?: number } = {}): MessageAction {
  const cur = getMessageAction(db, id);
  if (!cur) throw new Error(`No message draft with id ${id}`);
  if (!MOVES[cur.status].includes(to)) throw new Error(`A message can't go from ${cur.status} to ${to}.`);
  const res = db
    .query("UPDATE message_actions SET status = ?, error = ?, sent_at = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(to, patch.error ?? (to === "sent" ? null : cur.error), patch.sentAt ?? cur.sentAt, Date.now(), id, cur.status);
  if (res.changes === 0) throw new Error(`The message ${id} changed while updating it.`);
  bus.emit({ type: "changed" });
  return getMessageAction(db, id)!;
}
