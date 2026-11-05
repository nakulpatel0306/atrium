import { expect, test } from "bun:test";
import { editLine, type Line } from "../../src/tui/edit";
import { key } from "./key";

const line = (value: string, cursor = value.length): Line => ({ value, cursor });

test("typing, editing, submitting", () => {
  expect(editLine(line("ab"), "c", key())).toEqual(line("abc"));
  expect(editLine(line("abc"), "", key({ backspace: true }))).toEqual(line("ab"));
  const left = editLine(line("ab"), "", key({ leftArrow: true })) as Line;
  expect(left).toEqual(line("ab", 1));
  expect(editLine(left, "x", key())).toEqual(line("axb", 2));
  expect(editLine(line("ab", 0), "", key({ delete: true }))).toEqual(line("b", 0));
  expect(editLine(line("ab", 1), "a", key({ ctrl: true }))).toEqual(line("ab", 0));
  expect(editLine(line("ab", 0), "e", key({ ctrl: true }))).toEqual(line("ab", 2));
  expect(editLine(line("ab"), "u", key({ ctrl: true }))).toEqual(line(""));
  expect(editLine(line("ab"), "", key({ return: true }))).toBe("submit");
  expect(editLine(line("ab"), "", key({ escape: true }))).toBe("cancel");
});

test("backspace removes a whole wide character", () => {
  expect(editLine(line("a🙂"), "", key({ backspace: true }))).toEqual(line("a"));
});

test("pasted text goes into the prompt whole", () => {
  expect(editLine(line(""), "fix the jjj bug", key())).toEqual(line("fix the jjj bug"));
  expect(editLine(line(""), "two\nlines\x1b[2J", key())).toEqual(line("two lines"));
});
