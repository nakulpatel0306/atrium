import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { CAN_LINE, CANT_LINE, capabilityLines, messagingState, setMessagingState } from "../../src/engine/capabilities";
import { openDb } from "../../src/engine/db";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const HEADING = "What Atrium can and can't do right now:";
const MESSAGE_TASK_MSG =
  'Messages: you can\'t send texts yourself. To have Atrium send one, end your reply with a fenced block tagged atrium-message holding {"to": "<name, phone or email>", "text": "<exact text>"}, then the OUTCOME line. For a group chat, hold {"group": "<chat name>", "people": ["<name>", …], "text": "<exact text>"} instead (either "group" or "people" may be left out). Atrium shows it to the user and sends it only when they press Send.';
const TASK_MSG =
  "Messages: you can't send texts, and Atrium won't send one from this task. If the task needs a text sent, say so in your summary; the user can ask Atrium to text them.";
const SETUP_MSG = 'Messages: for a request to text or message someone, reply with {"kind":"message", …} (see the rules below), not a space of tasks.';
const SUFFIX = {
  untested: "The first send asks macOS for permission to control Messages, so the user must be at their Mac.",
  needs_automation: "Sending is blocked until the user allows Automation for Messages in System Settings.",
  signed_out: "Sending is blocked until Messages is signed in to iMessage.",
};

test("the fixed lines", () => {
  expect(CAN_LINE).toBe("Can: read and edit files in the task's folder or repo branch; run tests in repo spaces; write notes and drafts.");
  expect(CANT_LINE).toBe(
    "Can't: browse the web or look anything up online; read email, calendars or chats; send email; make calls or payments; open or control apps.",
  );
});

test("task and setup lists, in every messaging state", () => {
  expect(messagingState(db)).toBe("untested");
  for (const state of ["untested", "ready", "needs_automation", "signed_out"] as const) {
    setMessagingState(db, state);
    expect(messagingState(db)).toBe(state);
    const task = capabilityLines(db, "task");
    const setup = capabilityLines(db, "setup");
    const message = capabilityLines(db, "message");
    for (const lines of [task, setup, message]) {
      expect(lines.slice(0, 3)).toEqual([HEADING, CAN_LINE, CANT_LINE]);
      if (state === "ready") for (const s of Object.values(SUFFIX)) expect(lines.join("\n")).not.toContain(s);
      else expect(lines).toContain(SUFFIX[state]);
    }
    expect(task).toContain(TASK_MSG);
    expect(task.join("\n")).not.toContain("atrium-message");
    expect(message).toContain(MESSAGE_TASK_MSG);
    expect(message.join("\n")).not.toContain('"kind":"message"');
    expect(task.join("\n")).not.toContain('"kind":"message"');
    expect(setup).toContain(SETUP_MSG);
    expect(setup.join("\n")).not.toContain("atrium-message");
  }
});

test("an unknown stored state reads as untested", () => {
  db.query("INSERT INTO settings (key, value) VALUES ('messaging.state', 'weird')").run();
  expect(messagingState(db)).toBe("untested");
});
