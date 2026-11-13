// What agents are told about Atrium, so a task never claims something it had no way to do.
export const CAN_LINE = "Can: read and edit files in the task's folder or repo branch; run tests in repo spaces; write notes and drafts.";
export const CANT_LINE = "Can't: browse the web or look anything up online; read email, calendars or chats; send messages or email; make calls or payments; open or control apps.";

export const capabilityLines = (): string[] => ["What Atrium can and can't do right now:", CAN_LINE, CANT_LINE];
