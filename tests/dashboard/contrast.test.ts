import { expect, test } from "bun:test";
import { contrastFailures, ratio, tokens } from "../copy/contrast";

test("contrast math matches WCAG", () => {
  expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  expect(tokens()["--bg"]).toMatch(/^#/);
});

test("every text token is readable on every surface", () => {
  expect(contrastFailures()).toEqual([]);
});
