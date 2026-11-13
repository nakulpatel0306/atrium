import { expect, test } from "bun:test";
import { CAN_LINE, CANT_LINE, capabilityLines } from "../../src/engine/capabilities";

test("the fixed lines", () => {
  expect(CAN_LINE).toBe("Can: read and edit files in the task's folder or repo branch; run tests in repo spaces; write notes and drafts.");
  expect(CANT_LINE).toBe(
    "Can't: browse the web or look anything up online; read email, calendars or chats; send messages or email; make calls or payments; open or control apps.",
  );
});

test("agents are told what Atrium can and can't do, and nothing about texting", () => {
  const lines = capabilityLines();
  expect(lines).toEqual(["What Atrium can and can't do right now:", CAN_LINE, CANT_LINE]);
  expect(lines.join("\n")).not.toMatch(/atrium-message|iMessage|Messages:/);
});
