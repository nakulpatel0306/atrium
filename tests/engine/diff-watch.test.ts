import { expect, test } from "bun:test";
import { createDiffNotifier, isFileEdit } from "../../src/engine/diff-watch";

test("Claude's file-editing tool lines and Bash lines count as edits; reads don't", () => {
  for (const line of ["→ Edit src/a.ts", "→ Write notes.md", "→ MultiEdit src/b.ts", "→ NotebookEdit nb.ipynb", "→ Bash bun x prettier -w ."]) expect(isFileEdit(line)).toBe(true);
  for (const line of ["→ Read src/a.ts", "→ Grep footer", "Edit the file", "→ Editor x", "→ Bashful"]) expect(isFileEdit(line)).toBe(false);
});

test("at most one event per window per task, and the last edit is never dropped", async () => {
  const sent: string[] = [];
  const n = createDiffNotifier((id) => sent.push(id), { windowMs: 60 });
  const stopA = n.watch("a", false);
  const stopB = n.watch("b", false);
  n.edited("a");
  n.edited("a");
  n.edited("a");
  n.edited("b");
  expect(sent).toEqual(["a", "b"]);
  await Bun.sleep(90);
  expect(sent).toEqual(["a", "b", "a"]);
  n.edited("b");
  // Ending the run sends what was waiting instead of losing it.
  stopB();
  expect(sent).toEqual(["a", "b", "a", "b"]);
  stopA();
  await Bun.sleep(80);
  expect(sent).toHaveLength(4);
});

test("the timer for agents that don't report edits runs only between watch and its stop", async () => {
  let count = 0;
  const n = createDiffNotifier(() => count++, { windowMs: 1, pollMs: 20 });
  await Bun.sleep(50);
  expect(count).toBe(0);
  const stop = n.watch("a", true);
  await Bun.sleep(75);
  stop();
  const seen = count;
  expect(seen).toBeGreaterThanOrEqual(2);
  await Bun.sleep(60);
  expect(count).toBe(seen);
});
