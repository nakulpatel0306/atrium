import { afterEach, expect, test } from "bun:test";
import { stampConsole } from "../../src/engine/logfile";

const original = { log: console.log, error: console.error };
afterEach(() => {
  console.log = original.log;
  console.error = original.error;
});

test("every engine log line starts with its time", () => {
  const lines: string[] = [];
  console.log = (s: string) => void lines.push(`out ${s}`);
  console.error = (s: string) => void lines.push(`err ${s}`);
  stampConsole(() => new Date("2026-11-06T21:30:05.000Z"));
  console.log("Atrium running at %s", "http://127.0.0.1:7420");
  console.error("Shutdown error:", new Error("boom").message);
  expect(lines).toEqual(["out 2026-11-06T21:30:05.000Z Atrium running at http://127.0.0.1:7420", "err 2026-11-06T21:30:05.000Z Shutdown error: boom"]);
});
