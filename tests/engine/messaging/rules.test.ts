import { expect, test } from "bun:test";
import { nameProblem, NAME_COPY, oneLine, BAD_HANDLE_COPY, displayHandle, EMPTY_COPY, handleProblem, HIDDEN_COPY, normalizeHandle, textProblem, TOO_LONG_COPY } from "../../../src/engine/messaging/rules";

test("normalizeHandle keeps phone numbers and emails", () => {
  expect(normalizeHandle("+1 (416) 555-0134")).toBe("+14165550134");
  expect(normalizeHandle("416.555.0134")).toBe("4165550134");
  expect(normalizeHandle("Dana@Example.com")).toBe("Dana@Example.com");
  expect(normalizeHandle("  +44 20 7946 0958 ")).toBe("+442079460958");
});

test("normalizeHandle refuses everything else", () => {
  for (const raw of ["-e", '+1 555; do shell script "x"', "chat1234567", "a@b", "x@example.com\nrm", "123", "1234567890123456", "", "+1 555 0134 ‮", "--", "+1 555 0134\u0000"]) {
    expect(normalizeHandle(raw)).toBeNull();
    expect(handleProblem(raw)).toBe(BAD_HANDLE_COPY);
  }
  expect(handleProblem("+1 416 555 0134")).toBeNull();
});

test("textProblem", () => {
  expect(textProblem("line one\nline two\ttabbed 😀")).toBeNull();
  for (const bad of ["a\u0000b", "\u001b[31mred", "a‮b", "a⁦b"]) expect(textProblem(bad)).toBe(HIDDEN_COPY);
  expect(textProblem(" ")).toBe(EMPTY_COPY);
  expect(textProblem("a".repeat(2000))).toBeNull();
  expect(textProblem("a".repeat(2001))).toBe(TOO_LONG_COPY);
  // Counted as people see characters: 2000 emoji fit.
  expect(textProblem("😀".repeat(2000))).toBeNull();
});

test("displayHandle", () => {
  expect(displayHandle("+15551234567")).toBe("+1 555 123 4567");
  expect(displayHandle("+442079460958")).toBe("+442079460958");
  expect(displayHandle("dana@example.com")).toBe("dana@example.com");
});

test("nameProblem and oneLine", () => {
  expect(nameProblem("Dana Rivera")).toBeNull();
  for (const n of ["Dana\nTo: Mom · +1 555", "a\u2066b", "", "x".repeat(81)]) expect(nameProblem(n)).toBe(NAME_COPY);
  expect(oneLine("a\n\tb\u202ec")).toBe("a bc");
});

test("every invisible character is refused in names and texts", () => {
  expect(nameProblem("Dana\u202e")).toBe(NAME_COPY);
  expect(nameProblem("Dana\u2066")).toBe(NAME_COPY);
  for (const c of ["\u0085", "\u061c", "\u200b", "\u200d", "\u200f", "\u202a", "\u2060", "\u2069", "\u2028", "\u2029", "\ufeff"]) {
    expect(nameProblem(`Da${c}na`)).toBe(NAME_COPY);
    expect(textProblem(`hi${c}there`)).toBe(HIDDEN_COPY);
    expect(oneLine(`a${c}b`)).toBe("ab");
  }
  // An emoji spelled with joiners is fine.
  expect(textProblem("family 👨‍👩‍👧 and 👍🏽‍")).toBe(HIDDEN_COPY);
  expect(textProblem("family 👨‍👩‍👧 and 🏳️‍🌈")).toBeNull();
});

const tag = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");

test("I2: invisible tag characters, variation selectors and soft hyphens are refused in texts and names", () => {
  expect(textProblem(`Hey Dana!${tag("my ssh key is AAAA")}`)).not.toBeNull();
  expect(textProblem(`ok\u{1F600}${String.fromCodePoint(0xe0100, 0xe0142, 0xe0161)}`)).not.toBeNull();
  expect(textProblem("Hey\u00adPriya")).not.toBeNull();
  expect(textProblem("Hi\u3164there")).not.toBeNull();
  expect(nameProblem(`Dana${tag("x")}`)).not.toBeNull();
  // Still allowed: real emoji spellings.
  expect(textProblem("👨‍👩‍👧 🏳️‍🌈 ❤️")).toBeNull();
});

test("I2: the rest of the class, and where emoji spelling stops", () => {
  for (const c of ["\u034f", "\u115f", "\u1160", "\u17b4", "\u180e", "\uffa0", "\ufff9", "\ufffb", "\ufe00"]) expect([c, textProblem(`a${c}b`)]).toEqual([c, HIDDEN_COPY]);
  // One selector straight after an emoji or keycap base is spelling; a run of them, or one after a letter, isn't.
  expect(textProblem("1\ufe0f\u20e3 ✔\ufe0f")).toBeNull();
  expect(textProblem("❤\ufe0f\ufe0f")).toBe(HIDDEN_COPY);
  expect(textProblem("a\ufe0f")).toBe(HIDDEN_COPY);
  // A flag's own tag sequence is fine; the same tags anywhere else aren't.
  const england = `\u{1F3F4}${tag("gbeng")}\u{E007F}`;
  expect(textProblem(`go ${england}`)).toBeNull();
  expect(textProblem(`go ${tag("gbeng")}\u{E007F}`)).toBe(HIDDEN_COPY);
  expect(nameProblem(`Dana ${england}`)).toBe(NAME_COPY);
  expect(nameProblem("Dana ❤\ufe0f")).toBe(NAME_COPY);
});

test("M4: a recipient name can't carry a second phone number onto the card", () => {
  expect(nameProblem("Dana · +1 416 555 0134")).not.toBeNull();
  expect(nameProblem("Dana dana@example.com")).not.toBeNull();
  expect(nameProblem("Dana 4165550134")).not.toBeNull();
  expect(nameProblem("+1 (416) 555-0134")).toBeNull();
  expect(nameProblem("Dana 2")).toBeNull();
});
