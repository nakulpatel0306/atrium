import { afterEach, expect, test } from "bun:test";
import { cleanup } from "ink-testing-library";
import { fakeClient } from "./fake-client";
import { ids, makeState } from "./fixtures";
import { openApp } from "./harness";

afterEach(() => cleanup());

test("a keypress over a 5 MB transcript renders in under 30 ms", async () => {
  const line = (i: number) => `${String(i).padStart(6, "0")} ${"tool output with some text that runs on ".repeat(2)}end`;
  let text = "";
  for (let i = 0; text.length < 5 * 1024 * 1024; i++) text += `${line(i)}\n`;
  const client = fakeClient(makeState());
  client.respond(`/api/runs/${ids.reviewRun}/transcript`, { ok: true, data: text });
  const app = openApp(client);
  await app.frame((f) => f.includes("[1] Spaces"));
  const opened = performance.now();
  await app.type("2", "j", "t");
  await app.frame((f) => f.includes("000000 tool output"), 10_000);
  const openMs = performance.now() - opened;
  const times: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const start = performance.now();
    app.stdin.write("j");
    // Scrolled one line: the line that was on top is gone.
    await app.frame((f) => !f.includes(`${String(i - 1).padStart(6, "0")} tool`));
    times.push(performance.now() - start);
  }
  console.log(`5 MB transcript: open+wrap ${openMs.toFixed(0)} ms; keypress renders ${times.map((t) => t.toFixed(1)).join(", ")} ms`);
  expect(Math.max(...times)).toBeLessThan(30);
}, 20_000);
