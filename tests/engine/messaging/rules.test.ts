import { expect, test } from "bun:test";
import { BAD_HANDLE_COPY, displayHandle, EMPTY_COPY, handleProblem, HIDDEN_COPY, normalizeHandle, textProblem, TOO_LONG_COPY } from "../../../src/engine/messaging/rules";

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
