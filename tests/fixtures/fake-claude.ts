#!/usr/bin/env bun
// Stands in for the `claude` CLI; mirrors the stream-json lines Claude Code 2.1.x emits.
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const out = (o: unknown) => console.log(JSON.stringify(o));
const sessionId = "fake-session";

if (process.argv[2] === "--version") {
  console.log(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.318"} (Claude Code)`);
  process.exit(0);
}
if (process.argv[2] === "auth" && process.argv[3] === "status") {
  // A check that fails outright (a timeout, a rate-limit message) prints no status at all.
  if (process.env.FAKE_CLAUDE_AUTH === "error") {
    console.error("Request timed out");
    process.exit(1);
  }
  const signedOut = process.env.FAKE_CLAUDE_AUTH === "signed-out";
  console.log(JSON.stringify({ loggedIn: !signedOut, email: "someone@example.com" }));
  process.exit(signedOut ? 1 : 0);
}
if (process.env.FAKE_CLAUDE_ARGV) await Bun.write(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(process.argv.slice(2)));
// The prompt arrives on stdin; a test can keep a copy of exactly what the CLI was sent.
if (process.env.FAKE_CLAUDE_STDIN) await Bun.write(process.env.FAKE_CLAUDE_STDIN, await Bun.stdin.text());
// Names only, never values: tests check which variables reach the CLI.
if (process.env.FAKE_CLAUDE_ENV) await Bun.write(process.env.FAKE_CLAUDE_ENV, JSON.stringify(Object.keys(process.env)));

out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: ["Read", "Bash"] });

function result(text: string, isError = false) {
  out({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result: text,
    session_id: sessionId,
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: Number(process.env.FAKE_CLAUDE_CACHE_READ ?? 0), cache_creation_input_tokens: Number(process.env.FAKE_CLAUDE_CACHE_WRITE ?? 0) },
    // Per-model totals, subagents included, as Claude Code adds them; a test passes the JSON it wants back.
    ...(process.env.FAKE_CLAUDE_MODEL_USAGE && { modelUsage: JSON.parse(process.env.FAKE_CLAUDE_MODEL_USAGE) }),
  });
}

if (mode === "crash_after_text") {
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: process.env.FAKE_CLAUDE_TEXT ?? "" }] } });
  console.error("boom: something exploded");
  process.exit(2);
}
if (mode === "sandbox_unavailable") {
  console.error("Error: sandbox unavailable: sandbox-exec could not start");
  process.exit(1);
}
if (mode === "crash") {
  console.error("line 1\nboom: something exploded");
  process.exit(2);
}
if (mode === "logged_out") {
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Invalid API key · Please run /login" }] } });
  result("Invalid API key · Please run /login", true);
  process.exit(1);
}
if (mode === "rate_limited" || mode === "rate_limited_usage") {
  const windows = mode === "rate_limited_usage" ? { unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1893456000 } } } : {};
  out({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1893456000, rateLimitType: "five_hour", ...windows },
  });
  result("Claude AI usage limit reached", true);
  process.exit(1);
}
if (mode === "rate_limited_text") {
  const text = process.env.FAKE_CLAUDE_LIMIT_TEXT ?? "Claude AI usage limit reached|1893456000";
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  result(text, true);
  process.exit(1);
}
if (mode === "slow") {
  // A step's usage repeats on each of its lines, as Claude Code's do; its output count is a floor until it finishes.
  const step = { id: "msg_slow_1", model: "claude-haiku-5-5", role: "assistant", usage: { input_tokens: 3, output_tokens: 8, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 0 } } };
  out({ type: "assistant", message: { ...step, content: [{ type: "text", text: "Starting a long job." }] } });
  out({ type: "assistant", message: { ...step, content: [{ type: "text", text: "Still going." }] } });
  await Bun.sleep(30_000);
  result("Finished the long job.");
  process.exit(0);
}
// Plays an agent that made files: copies every fixture except the summary into the run folder, then answers with it.
if (mode === "write_files") {
  const { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync } = await import("node:fs");
  const { basename, join } = await import("node:path");
  const from = process.env.FAKE_CLAUDE_FILES!;
  const summary = process.env.FAKE_CLAUDE_SUMMARY!;
  for (const name of readdirSync(from)) if (name !== basename(summary)) copyFileSync(join(from, name), join(process.cwd(), name));
  if (process.env.FAKE_CLAUDE_CC_DIR === "1") {
    mkdirSync(join(process.cwd(), ".claude", ".cc-writes"), { recursive: true });
    chmodSync(join(process.cwd(), ".claude", ".cc-writes"), 0o700);
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Planning the week." }] } });
  result(readFileSync(summary, "utf8"));
  process.exit(0);
}
if (mode === "argv") {
  result(JSON.stringify({ argv: process.argv.slice(2), stdin: await Bun.stdin.text() }));
  process.exit(0);
}

if (mode === "ok_usage" || mode === "ok_usage_no_reset") {
  const reset = mode === "ok_usage" ? { resetsAt: 1893459600 } : {};
  out({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1893456000,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.14, ...reset },
        seven_day: { utilization: 0.31, resetsAt: 1893801600 },
      },
    },
  });
}
out({
  type: "rate_limit_event",
  rate_limit_info: { status: mode === "ok_warning" ? "allowed_warning" : "allowed", resetsAt: 1893456000, rateLimitType: "five_hour" },
});
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Looking at the repo." }] } });
// A subagent's step, then the main agent's: only the main agent's says how much context it holds.
out({ type: "assistant", parent_tool_use_id: "toolu_0", message: { role: "assistant", usage: { input_tokens: 999_999 }, content: [{ type: "text", text: "Scouting." }] } });
out({
  type: "assistant",
  message: {
    role: "assistant",
    usage: { input_tokens: 10, cache_read_input_tokens: Number(process.env.FAKE_CLAUDE_CONTEXT ?? 0), cache_creation_input_tokens: 5 },
    content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/README.md" } }],
  },
});
out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "# fixture" }] } });
// FAKE_CLAUDE_TEXT stands in for the reply, so a dev engine can drive the setup agent. With by_prompt, the reply is
// the first of FAKE_CLAUDE_REPLIES (a JSON file of [substring, reply] pairs) whose substring is in the prompt.
if (mode === "by_prompt") {
  const { readFileSync } = await import("node:fs");
  const prompt = await Bun.stdin.text();
  const pairs = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_REPLIES!, "utf8")) as [string, string][];
  result(pairs.find(([needle]) => prompt.includes(needle))?.[1] ?? process.env.FAKE_CLAUDE_TEXT ?? "All done.");
} else {
  result(process.env.FAKE_CLAUDE_TEXT ?? "All done.");
}
