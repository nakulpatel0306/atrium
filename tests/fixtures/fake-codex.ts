#!/usr/bin/env bun
// Stands in for the `codex` CLI; mirrors the `exec --json` lines Codex 0.147 emits.
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "ok";
const out = (o: unknown) => console.log(JSON.stringify(o));

if (process.env.FAKE_CODEX_ARGV) await Bun.write(process.env.FAKE_CODEX_ARGV, JSON.stringify(process.argv.slice(2)));
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
if (scenario === "slow") await Bun.sleep(30_000);

const agentMessage = (text: string) => out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
if (scenario === "echo") {
  agentMessage(stdin);
} else {
  agentMessage("Did the thing.");
  out({
    type: "item.completed",
    item: { id: "item_1", type: "command_execution", command: "bun test", aggregated_output: "", exit_code: 0, status: "completed" },
  });
}
out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80 } });
