#!/usr/bin/env bun
// Stands in for the `agy` CLI; mirrors the `--output-format stream-json` lines agy 1.5.0 emits.
const scenario = process.env.FAKE_AGY_SCENARIO ?? "ok";
const out = (o: unknown) => console.log(JSON.stringify(o));
const step = (s: Record<string, unknown>) => out({ event: "step_update", step_update: { conversation_id: "c1", ...s } });

if (process.env.FAKE_AGY_ARGV) await Bun.write(process.env.FAKE_AGY_ARGV, JSON.stringify(process.argv.slice(2)));
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("agy 1.5.0");
  process.exit(0);
}
const prompt = args[args.indexOf("-p") + 1] ?? "";

if (args[0] === "models") {
  if (scenario === "slow") await Bun.sleep(30_000);
  if (scenario === "auth") {
    console.error("authentication required");
    process.exit(1);
  }
  console.log("Fetching available models...");
  console.log(scenario === "no-models" ? "claude-opus-5-5-low\tClaude Opus 5.5 (Low)" : "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)");
  process.exit(0);
}

if (scenario === "auth") {
  console.error("authentication required");
  process.exit(1);
}

out({ event: "init", conversation_id: "c1", init: { model: "gemini-3.8-flash-medium", cwd: process.cwd(), tools: [], permission_mode: "request-review" } });
step({ step_index: 0, state: "DONE", step_type: "user_input" });

if (scenario === "quota") {
  out({ event: "result", result: { conversation_id: "c1", status: "ERROR", error: "Quota exceeded. Try again in 2h 5m.", response: "" } });
  process.exit(1);
}
if (scenario === "fail") {
  out({ event: "result", result: { conversation_id: "c1", status: "ERROR", error: "boom", response: "" } });
  process.exit(1);
}
if (scenario === "denied") {
  out({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "", denied_actions: [{ action: "command" }] } });
  console.error('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.');
  process.exit(0);
}
if (scenario === "slow") await Bun.sleep(30_000);

// "tmp" reports the temp env it was given and proves that dir is writable from inside the sandbox.
if (scenario === "tmp") await Bun.write(`${process.env.TMPDIR}/probe.txt`, "x");
const tmpEnv = JSON.stringify({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP });
const text = scenario === "echo" ? prompt : scenario === "tmp" ? tmpEnv : "Did the thing.";
step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: text });
step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n", usage: { input_tokens: 1200, output_tokens: 80 } });
if (scenario === "ok") {
  step({
    step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { command: "bun test" }, output: "ok" },
  });
}
out({
  event: "result",
  result: {
    conversation_id: "c1", status: "SUCCESS", response: `${text}\n`, num_turns: 1,
    usage: { input_tokens: 1200, output_tokens: 80, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1280 },
  },
});
