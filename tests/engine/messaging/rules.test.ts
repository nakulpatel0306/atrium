import { expect, test } from "bun:test";
import { nameProblem, NAME_COPY, oneLine, BAD_HANDLE_COPY, displayHandle, EMPTY_COPY, handleProblem, HIDDEN_COPY, normalizeHandle, textProblem, TOO_LONG_COPY } from "../../../src/engine/messaging/rules";

test("normalizeHandle keeps phone numbers and emails", () => {
  expect(normalizeHandle("+1 (416) 555-0134")).toBe("+14165550134");
  expect(normalizeHandle("416.555.0134")).toBe("4165550134");
  expect(normalizeHandle("Dana@Example.com")).toBe("Dana@Example.com");
  expect(normalizeHandle("  +44 20 7946 0958 ")).toBe("+442079460958");
});

test("normalizeHandle refuses everything else", () => {
  for (const raw of ["-e", '+1 555; do shell script "x"', "chat1234567", "a@b", "x@y.com\nrm", "123", "1234567890123456", "", "+1 555 0134 ‮", "--", "+1 555 0134\u0000"]) {
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
    expect(nameProblem(`Ta${c}lal`)).toBe(NAME_COPY);
    expect(textProblem(`hi${c}there`)).toBe(HIDDEN_COPY);
    expect(oneLine(`a${c}b`)).toBe("ab");
  }
  // An emoji spelled with joiners is fine.
  expect(textProblem("family 👨‍👩‍👧 and 👍🏽‍")).toBe(HIDDEN_COPY);
  expect(textProblem("family 👨‍👩‍👧 and 🏳️‍🌈")).toBeNull();
});
