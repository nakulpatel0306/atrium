#!/usr/bin/env bun
// Stands in for a project's test command: passes when the repo's status.txt says "pass", and otherwise fails the
// way a test runner does, naming the failing test. Run by the loop's checks, inside their sandbox.
import { existsSync, readFileSync } from "node:fs";

const status = existsSync("status.txt") ? readFileSync("status.txt", "utf8").trim() : "missing";
if (status === "pass") {
  console.log("3 pass\n0 fail");
  process.exit(0);
}
console.log(`(fail) adds the totals: expected "pass", got "${status}"\n2 pass\n1 fail`);
process.exit(1);
