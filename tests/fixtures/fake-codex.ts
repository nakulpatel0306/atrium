#!/usr/bin/env bun
// Stands in for the `codex` CLI; mirrors the `exec --json` lines Codex 0.147 emits.
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "ok";
const out = (o: unknown) => console.log(JSON.stringify(o));
const agentMessage = (text: string) => out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });

if (process.env.FAKE_CODEX_ARGV) await Bun.write(process.env.FAKE_CODEX_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (scenario === "logged-out") process.exit(1);
  console.error("Logged in using ChatGPT");
  process.exit(0);
}
const stdin = await Bun.stdin.text();

if (scenario === "logged-out") {
  console.error("Not logged in. Run codex login");
  process.exit(1);
}

out({ type: "thread.started", thread_id: "fake-thread" });
out({ type: "turn.started" });

if (scenario === "limit") {
  const message =
    "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:40 PM.";
  out({ type: "error", message });
  out({ type: "turn.failed", error: { message } });
  process.exit(1);
}
if (scenario === "fail") {
  out({ type: "turn.failed", error: { message: "boom" } });
  process.exit(1);
}
if (scenario === "no-turn") {
  agentMessage("Half done.");
  process.exit(0);
}
if (scenario === "stray") {
  // A background child that would outlive the CLI; its pid lets the test check it was reaped.
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  child.unref();
  await Bun.write(process.env.FAKE_CODEX_PIDFILE!, String(child.pid));
}
if (scenario === "slow") await Bun.sleep(30_000);

if (scenario === "echo") {
  agentMessage(stdin);
} else if (scenario === "tmp") {
  // Reports the temp env it was given and proves that dir is writable from inside the sandbox.
  await Bun.write(`${process.env.TMPDIR}/probe.txt`, "x");
  agentMessage(JSON.stringify({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }));
} else {
  agentMessage("Did the thing.");
  out({
    type: "item.completed",
    item: { id: "item_1", type: "command_execution", command: "bun test", aggregated_output: "", exit_code: 0, status: "completed" },
  });
}
out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80 } });
