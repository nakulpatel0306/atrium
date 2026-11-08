import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "./settings";

// What agents are told about Atrium, so a task never claims something it had no way to do.
export type MessagingState = "untested" | "ready" | "needs_automation" | "signed_out";
const STATES: readonly MessagingState[] = ["untested", "ready", "needs_automation", "signed_out"];

export const messagingState = (db: Database): MessagingState => {
  const v = getSetting(db, "messaging.state");
  return STATES.includes(v as MessagingState) ? (v as MessagingState) : "untested";
};

export const setMessagingState = (db: Database, s: MessagingState): void => setSetting(db, "messaging.state", s);

export const CAN_LINE = "Can: read and edit files in the task's folder or repo branch; run tests in repo spaces; write notes and drafts.";
export const CANT_LINE =
  "Can't: browse the web or look anything up online; read email, calendars or chats; send email; make calls or payments; open or control apps.";
// Only a task Atrium made for drafting a text is told about the block; any other task's block is ignored.
const MESSAGE_TASK_MESSAGES =
  'Messages: you can\'t send texts yourself. To have Atrium send one, end your reply with a fenced block tagged atrium-message holding {"to": "<name, phone or email>", "text": "<exact text>"}, then the OUTCOME line. For a group chat, hold {"group": "<chat name>", "people": ["<name>", …], "text": "<exact text>"} instead (either "group" or "people" may be left out). Atrium shows it to Nakul and sends it only when he presses Send.';
const TASK_MESSAGES =
  "Messages: you can't send texts, and Atrium won't send one from this task. If the task needs a text sent, say so in your summary; Nakul can ask Atrium to text them.";
const SETUP_MESSAGES = 'Messages: for a request to text or message someone, reply with {"kind":"message", …} (see the rules below), not a space of tasks.';

const STATE_LINE: Record<MessagingState, string | null> = {
  untested: "The first send asks macOS for permission to control Messages, so Nakul must be at his Mac.",
  ready: null,
  needs_automation: "Sending is blocked until Nakul allows Automation for Messages in System Settings.",
  signed_out: "Sending is blocked until Messages is signed in to iMessage.",
};

export function capabilityLines(db: Database, who: "setup" | "task" | "message"): string[] {
  const state = STATE_LINE[messagingState(db)];
  const messages = who === "task" ? TASK_MESSAGES : who === "message" ? MESSAGE_TASK_MESSAGES : SETUP_MESSAGES;
  return ["What Atrium can and can't do right now:", CAN_LINE, CANT_LINE, messages, ...(state ? [state] : [])];
}
