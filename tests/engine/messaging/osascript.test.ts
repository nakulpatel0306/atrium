import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOsa } from "../../../src/engine/messaging/osascript";
import { MessagingProblem, PROBLEM_COPY, problemFor } from "../../../src/engine/messaging/problems";
import { LOOKUP_SCRIPT, SEND_SCRIPT } from "../../../src/engine/messaging/scripts";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let log: string;
beforeEach(() => {
  home = tempHome();
  log = join(home.home, "osa.log");
  process.env.FAKE_OSASCRIPT_LOG = log;
});
afterEach(() => {
  delete process.env.FAKE_OSASCRIPT_LOG;
  delete process.env.FAKE_OSASCRIPT_MODE;
  home.cleanup();
});

const logged = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);

const ADVERSARIAL = [
  `"double" and 'single'`,
  "back\\slash \\\\ two",
  `" & (do shell script "id") & "`,
  "end run\non run",
  "-e",
  "--",
  "-l JavaScript",
  "\n\n",
  "tab\there",
  "😀👍🏽",
  "مرحبا يا Dana، كيف حالك؟",
  "a".repeat(2000),
];

test("runOsa passes the fixed lines as -e and the arguments after --", async () => {
  const text = "you free sat?";
  const res = await runOsa(SEND_SCRIPT, ["iMessage", "+15551234567", text]);
  expect(res).toMatchObject({ code: 0, timedOut: false });
  expect(res.out.trim()).toBe("ATRIUM_SENT");
  expect(logged()).toEqual([[...SEND_SCRIPT.flatMap((l) => ["-e", l]), "--", "iMessage", "+15551234567", text]]);
});

test("adversarial text arrives as one literal argument", async () => {
  for (const t of ADVERSARIAL) await runOsa(SEND_SCRIPT, ["iMessage", "+15551234567", t]);
  const rows = logged();
  expect(rows.map((r) => r.at(-1))).toEqual(ADVERSARIAL);
  for (const r of rows) expect(r.length).toBe(SEND_SCRIPT.length * 2 + 4);
});

// No line names an application, so nothing here can ask macOS for any permission.
describe.skipIf(process.platform !== "darwin")("the real osascript", () => {
  test("hands every argument to on run argv literally", async () => {
    process.env.ATRIUM_OSASCRIPT_BIN = "/usr/bin/osascript";
    try {
      const echo = ["on run argv", "return item 1 of argv", "end run"];
      expect(echo.some((l) => /tell|application/i.test(l))).toBe(false);
      for (const t of ADVERSARIAL) {
        const res = await runOsa(echo, [t]);
        expect(res.out).toBe(`${t}\n`);
      }
    } finally {
      process.env.ATRIUM_OSASCRIPT_BIN = join(import.meta.dir, "..", "..", "fixtures", "fake-osascript.ts");
    }
  });
});

test("a missing osascript is code 127", async () => {
  process.env.ATRIUM_OSASCRIPT_BIN = join(home.home, "no-such-osascript");
  try {
    expect(await runOsa(SEND_SCRIPT, [])).toEqual({ code: 127, out: "", err: "", timedOut: false });
  } finally {
    process.env.ATRIUM_OSASCRIPT_BIN = join(import.meta.dir, "..", "..", "fixtures", "fake-osascript.ts");
  }
});

test("a hung osascript is killed", async () => {
  process.env.FAKE_OSASCRIPT_MODE = "hang";
  const res = await runOsa(SEND_SCRIPT, ["iMessage", "+15551234567", "hi"], { timeoutMs: 200 });
  expect(res.timedOut).toBe(true);
  const left = Bun.spawnSync(["pgrep", "-f", "fake-osascript"]);
  expect(left.stdout.toString().trim()).toBe("");
});

describe("problemFor", () => {
  const run = async (mode: string, script = SEND_SCRIPT) => {
    process.env.FAKE_OSASCRIPT_MODE = mode;
    return runOsa(script, ["iMessage", "+15551234567", "hi"]);
  };
  const kind = (p: MessagingProblem) => [p.kind, p.message];

  test("each fake mode maps to its kind and copy", async () => {
    expect(kind(problemFor(await run("denied"), "Messages"))).toEqual(["automation_denied", PROBLEM_COPY.automation_denied]);
    expect(kind(problemFor(await run("denied", LOOKUP_SCRIPT), "Contacts"))).toEqual(["contacts_denied", PROBLEM_COPY.contacts_denied]);
    expect(kind(problemFor(await run("no_account"), "Messages", "iMessage"))).toEqual(["signed_out", PROBLEM_COPY.signed_out]);
    expect(kind(problemFor(await run("no_account"), "Messages", "SMS"))).toEqual(["no_sms", PROBLEM_COPY.no_sms]);
    const fail = problemFor(await run("fail"), "Messages");
    expect(kind(fail)).toEqual(["other", PROBLEM_COPY.other.Messages]);
    expect(fail.raw).toBe("execution error: boom (-1708)");
    expect(kind(problemFor(await run("fail", LOOKUP_SCRIPT), "Contacts"))).toEqual(["other", PROBLEM_COPY.other.Contacts]);
  });

  test("timeouts and a missing binary", () => {
    const timedOut = { code: 137, out: "", err: "", timedOut: true };
    expect(kind(problemFor(timedOut, "Messages"))).toEqual(["timeout", PROBLEM_COPY.timeout.Messages]);
    expect(kind(problemFor(timedOut, "Contacts"))).toEqual(["timeout", PROBLEM_COPY.timeout.Contacts]);
    expect(problemFor({ code: 127, out: "", err: "", timedOut: false }, "Messages").kind).toBe("not_installed");
  });
});

test("the scripts take everything from argv", () => {
  for (const script of [SEND_SCRIPT, LOOKUP_SCRIPT]) {
    expect(script[0]).toBe("on run argv");
    expect(script.at(-1)).toBe("end run");
  }
  expect(SEND_SCRIPT.filter((l) => l.includes("application")).join()).toBe('tell application "Messages"');
  expect(LOOKUP_SCRIPT.filter((l) => l.includes("application")).join()).toBe('tell application "Contacts"');
});
