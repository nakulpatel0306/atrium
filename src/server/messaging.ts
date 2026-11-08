import type { Database } from "bun:sqlite";
import { AlreadyResolved, resolveApproval } from "../engine/approvals";
import { config } from "../engine/config";
import type { Messaging } from "../engine/messaging";
import { noMatchCopy, severalCopy } from "../engine/messaging/contacts";
import { MessagingProblem, SETTINGS_PANES } from "../engine/messaging/problems";
import { handleProblem, textProblem } from "../engine/messaging/rules";
import { NO_CHAT_COPY } from "../engine/messaging/send";
import { BadMessage, getMessageAction, messageHistory, updateGroupText, updateMessageDraft } from "../engine/messaging/store";
import { getSpace } from "../engine/spaces";
import { HttpError, json, readBody } from "./http";

// System Settings is offered only when it's the fix: a denied permission, not a timeout or an unknown failure.
const problemBody = (e: MessagingProblem) =>
  e.kind === "automation_denied" || e.kind === "contacts_denied" ? { error: e.message, pane: "automation" } : { error: e.message };

function guarded(fn: () => Response): Response {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AlreadyResolved) throw new HttpError(409, e.message);
    if (e instanceof BadMessage) throw new HttpError(400, e.message);
    throw e;
  }
}

// Message drafts: Send, Contacts lookup, finding a group chat, sending a group text separately, sent history, and the
// Automation settings pane. Returns null for paths it doesn't own.
export async function messagingRoute(db: Database, messaging: Messaging, req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const method = req.method;

  const sendM = method === "POST" ? pathname.match(/^\/api\/message-actions\/([^/]+)\/send$/) : null;
  if (sendM) {
    const action = getMessageAction(db, sendM[1]!);
    if (!action) throw new HttpError(404, "No such message draft.");
    const b = await readBody(req);
    if (typeof b.text !== "string") throw new HttpError(400, textProblem("")!);
    const badText = textProblem(b.text);
    if (badText) throw new HttpError(400, badText);
    if (action.group) {
      if (!action.group.chat) throw new HttpError(400, NO_CHAT_COPY);
      if (typeof b.chatId !== "string") throw new HttpError(400, NO_CHAT_COPY);
      const [text, chatId] = [b.text, b.chatId];
      return decide(() => updateGroupText(db, action.id, text, chatId), action.id);
    }
    const badHandle = typeof b.handle === "string" ? handleProblem(b.handle) : handleProblem("");
    if (badHandle) throw new HttpError(400, badHandle);
    if (b.service !== "iMessage" && b.service !== "SMS") throw new HttpError(400, "Send it as iMessage or SMS.");
    const patch = { text: b.text, handle: b.handle as string, service: b.service as "iMessage" | "SMS" };
    return decide(() => updateMessageDraft(db, action.id, patch), action.id);
  }

  const findM = method === "POST" ? pathname.match(/^\/api\/message-actions\/([^/]+)\/find-chat$/) : null;
  if (findM) {
    const action = getMessageAction(db, findM[1]!);
    if (!action?.group) throw new HttpError(404, "No such group text draft.");
    if (action.status !== "draft") throw new HttpError(409, new AlreadyResolved().message);
    try {
      const { shown, picked, message } = await messaging.findChat(action.id);
      return json({ chats: shown, picked: picked?.id ?? null, message });
    } catch (e) {
      if (e instanceof MessagingProblem) return json(problemBody(e), 409);
      if (e instanceof AlreadyResolved) throw new HttpError(409, e.message);
      throw e;
    }
  }

  const pickM = method === "POST" ? pathname.match(/^\/api\/message-actions\/([^/]+)\/chat$/) : null;
  if (pickM) {
    const action = getMessageAction(db, pickM[1]!);
    if (!action?.group) throw new HttpError(404, "No such group text draft.");
    const b = await readBody(req);
    if (typeof b.chatId !== "string") throw new HttpError(400, "Pick a group chat from the list.");
    const chatId = b.chatId;
    return guarded(() => json(messaging.pickChat(action.id, chatId)));
  }

  const apartM = method === "POST" ? pathname.match(/^\/api\/message-actions\/([^/]+)\/separately$/) : null;
  if (apartM) {
    const action = getMessageAction(db, apartM[1]!);
    if (!action?.group) throw new HttpError(404, "No such group text draft.");
    const b = await readBody(req);
    if (typeof b.text !== "string") throw new HttpError(400, textProblem("")!);
    const text = b.text;
    return guarded(() => json(messaging.separately(action.id, text)));
  }

  const lookM = method === "POST" ? pathname.match(/^\/api\/message-actions\/([^/]+)\/lookup$/) : null;
  if (lookM) {
    const action = getMessageAction(db, lookM[1]!);
    if (!action) throw new HttpError(404, "No such message draft.");
    try {
      const { candidates, picked } = await messaging.lookup(action.id);
      const message = candidates.length === 0 ? noMatchCopy(action.toName) : candidates.length > 1 ? severalCopy(action.toName) : null;
      return json({ candidates, picked, message });
    } catch (e) {
      if (e instanceof MessagingProblem) return json(problemBody(e), 409);
      if (e instanceof AlreadyResolved) throw new HttpError(409, e.message);
      throw e;
    }
  }

  const histM = method === "GET" ? pathname.match(/^\/api\/spaces\/([^/]+)\/messages$/) : null;
  if (histM) {
    if (!getSpace(db, histM[1]!)) throw new HttpError(404, "No such space.");
    return json(messageHistory(db, histM[1]!));
  }

  // His edits and his yes land together: what Messages gets is exactly what he saw when he pressed Send.
  function decide(edit: () => unknown, id: string): Response {
    return guarded(() => {
      db.transaction(() => {
        edit();
        resolveApproval(db, getMessageAction(db, id)!.approvalId, "approve");
      })();
      return json(getMessageAction(db, id));
    });
  }

  if (method === "POST" && pathname === "/api/messaging/open-settings") {
    const b = await readBody(req);
    if (b.pane !== "automation") throw new HttpError(400, "Atrium can only open the Automation settings.");
    const proc = Bun.spawn([config().openBin, SETTINGS_PANES.automation], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env } });
    if ((await proc.exited) !== 0) throw new HttpError(500, "Atrium couldn't open System Settings. Open it yourself and go to Privacy & Security › Automation.");
    return json({ ok: true });
  }
  return null;
}
