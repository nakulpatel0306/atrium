import { describe, expect, test } from "bun:test";
import { OUTCOME_INSTRUCTION, outcomeLabel, outcomeText, parseOutcome } from "../../src/engine/outcome";

describe("parseOutcome", () => {
  test("a plain done line is removed from the body", () => {
    expect(parseOutcome("Did it.\n\nOUTCOME: done")).toEqual({ outcome: "done", reason: null, body: "Did it." });
  });

  test("couldnt carries its reason", () => {
    expect(parseOutcome("x\nOUTCOME: couldnt - I don't have Dana's number.")).toEqual({
      outcome: "couldnt",
      reason: "I don't have Dana's number.",
      body: "x",
    });
  });

  test("tolerant forms all read as couldnt", () => {
    for (const line of [
      "**Outcome:** Couldn't – no number.",
      "`OUTCOME: could not — no number.`",
      "> outcome: COULDNT: no number.",
      "OUTCOME - couldn't - no number.",
      "OUTCOME: Couldn’t - no number.",
      "OUTCOME: couldnt - no number.   \n\n  \n",
    ]) {
      const p = parseOutcome(`Tried.\n${line}`);
      expect(p.outcome).toBe("couldnt");
      expect(p.reason).toBe("no number.");
      expect(p.body).toBe("Tried.");
    }
  });

  test("partial forms", () => {
    expect(parseOutcome("OUTCOME: partly done - wrote two of three files")).toMatchObject({ outcome: "partial", reason: "wrote two of three files" });
    expect(parseOutcome("OUTCOME: Partial")).toMatchObject({ outcome: "partial", reason: null });
  });

  test("only the last line counts", () => {
    const text = "OUTCOME: done\nActually I couldn't send it.";
    expect(parseOutcome(text)).toEqual({ outcome: "unknown", reason: null, body: text });
  });

  test("a missing line is unknown", () => {
    expect(parseOutcome("All done.")).toEqual({ outcome: "unknown", reason: null, body: "All done." });
    expect(parseOutcome("")).toEqual({ outcome: "unknown", reason: null, body: "" });
  });

  test("an unrecognised word is unknown and stays in the body", () => {
    expect(parseOutcome("Hm.\nOUTCOME: maybe")).toEqual({ outcome: "unknown", reason: null, body: "Hm.\nOUTCOME: maybe" });
  });

  test("a long reason is cut and control characters are removed", () => {
    const long = parseOutcome(`OUTCOME: couldnt - ${"a".repeat(400)}`);
    expect(long.reason!.length).toBe(300);
    expect(long.reason!.endsWith("…")).toBe(true);
    expect(parseOutcome("OUTCOME: couldnt - no\u0007 num\u001bber").reason).toBe("no number");
  });

  test("CRLF parses the same", () => {
    expect(parseOutcome("Did it.\r\n\r\nOUTCOME: done\r\n")).toEqual({ outcome: "done", reason: null, body: "Did it." });
  });

  test("a word that merely starts like one doesn't count", () => {
    expect(parseOutcome("OUTCOME: doneish").outcome).toBe("unknown");
  });
});

test("labels and instruction", () => {
  expect(outcomeLabel("couldnt")).toBe("not done");
  expect(outcomeLabel("partial")).toBe("partly done");
  expect(outcomeLabel("unknown")).toBeNull();
  expect(outcomeLabel("done")).toBeNull();
  expect(OUTCOME_INSTRUCTION.split("\n")[0]).toBe("Your very last line must be exactly one of:");
  expect(OUTCOME_INSTRUCTION).toContain("Drafting something is not sending it.");
});

test("M2: 'done' followed by a reason that says otherwise isn't done", () => {
  const p = parseOutcome("Wrote it.\nOUTCOME: done - but nothing was sent, the sandbox blocked Messages");
  expect(p.outcome).toBe("unknown");
  expect(p.reason).toBe("but nothing was sent, the sandbox blocked Messages");
});

test("an unknown with a reason says the reason", () => {
  expect(outcomeText("unknown", "it hedged.")).toBe("Atrium can't tell whether this was done: it hedged.");
  expect(outcomeText("couldnt", "Only Atrium can send messages, and nothing was sent.")).toBe("Couldn't do this: Only Atrium can send messages, and nothing was sent.");
});
