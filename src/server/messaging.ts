import type { Database } from "bun:sqlite";
import { AlreadyResolved, resolveApproval } from "../engine/approvals";
import { config } from "../engine/config";
import type { Messaging } from "../engine/messaging";
import { noMatchCopy, severalCopy } from "../engine/messaging/contacts";
import { MessagingProblem, SETTINGS_PANES } from "../engine/messaging/problems";
import { handleProblem, textProblem } from "../engine/messaging/rules";
import { BadMessage, getMessageAction, messageHistory, updateMessageDraft } from "../engine/messaging/store";
import { getSpace } from "../engine/spaces";
import { HttpError, json, readBody } from "./http";

// Message drafts: Send, Contacts lookup, sent history, and the Automation settings pane. Returns null for paths it
// doesn't own.
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
    const badHandle = typeof b.handle === "string" ? handleProblem(b.handle) : handleProblem("");
    if (badHandle) throw new HttpError(400, badHandle);
    if (b.service !== "iMessage" && b.service !== "SMS") throw new HttpError(400, "Send it as iMessage or SMS.");
    const patch = { text: b.text, handle: b.handle as string, service: b.service as "iMessage" | "SMS" };
    // His edits and his yes land together: what Messages gets is exactly what he saw when he pressed Send.
    try {
      db.transaction(() => {
        updateMessageDraft(db, action.id, patch);
        resolveApproval(db, action.approvalId, "approve");
      })();
    } catch (e) {
      if (e instanceof AlreadyResolved) throw new HttpError(409, e.message);
      if (e instanceof BadMessage) throw new HttpError(400, e.message);
      throw e;
    }
    return json(getMessageAction(db, action.id));
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
      if (e instanceof MessagingProblem) return json({ error: e.message, pane: "automation" }, 409);
      if (e instanceof AlreadyResolved) throw new HttpError(409, e.message);
      throw e;
    }
  }

  const histM = method === "GET" ? pathname.match(/^\/api\/spaces\/([^/]+)\/messages$/) : null;
  if (histM) {
    if (!getSpace(db, histM[1]!)) throw new HttpError(404, "No such space.");
    return json(messageHistory(db, histM[1]!));
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
