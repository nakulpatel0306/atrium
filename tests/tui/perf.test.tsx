import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";
import { KEY, openApp } from "./harness";

afterEach(() => cleanup());

// Nine keypresses over a transcript of this size, timed from the key to the frame that shows the scroll.
async function keypresses(bytes: number): Promise<{ openMs: number; times: number[] }> {
  const line = (i: number) => `${String(i).padStart(6, "0")} ${"tool output with some text that runs on ".repeat(2)}end`;
  let text = "";
  for (let i = 0; text.length < bytes; i++) text += `${line(i)}\n`;
  const client = fakeClient(makeState());
  client.respond(`/api/runs/${ids.reviewRun}/transcript`, { ok: true, data: text });
  const app = openApp(client);
  await app.frame((f) => f.includes("1 Home"), 10_000);
  const opened = performance.now();
  await app.type("2", KEY.tab, "j", "t");
  await app.frame((f) => f.includes("000000 tool output"), 10_000);
  const openMs = performance.now() - opened;
  const times: number[] = [];
  for (let i = 1; i <= 9; i++) {
    const start = performance.now();
    app.stdin.write("j");
    // Scrolled one line: the line that was on top is gone.
    await app.frame((f) => !f.includes(`${String(i - 1).padStart(6, "0")} tool`), 10_000);
    times.push(performance.now() - start);
  }
  cleanup();
  return { openMs, times: times.sort((a, b) => a - b) };
}

test("a keypress over a 5 MB transcript renders in under 30 ms, as the median of nine", async () => {
  // The same presses over a 50 KB transcript, timed just before, are what this machine takes right now for a render
  // whose cost can't depend on the transcript's size. Busy elsewhere (a parallel test run, CI), both slow down together.
  const small = await keypresses(50 * 1024);
  const big = await keypresses(5 * 1024 * 1024);
  console.log(`5 MB transcript: open+wrap ${big.openMs.toFixed(0)} ms; keypress renders ${big.times.map((t) => t.toFixed(1)).join(", ")} ms (50 KB: ${small.times.map((t) => t.toFixed(1)).join(", ")} ms)`);
  // The median, not the slowest: one press that lands while the machine is busy elsewhere says nothing about the
  // render. 30 ms on an idle Mac; on a busy one, no worse than four times the small transcript's own median.
  expect(big.times[4]!).toBeLessThan(Math.max(30, small.times[4]! * 4));
  // A wide ceiling still catches a render that has gone slow for real.
  expect(big.times.at(-1)!).toBeLessThan(Math.max(120, small.times.at(-1)! * 4));
}, 60_000);
