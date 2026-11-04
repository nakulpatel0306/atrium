#!/usr/bin/env bun
// Stands in for the `claude` CLI; mirrors the stream-json lines Claude Code 2.1.x emits.
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const out = (o: unknown) => console.log(JSON.stringify(o));
const sessionId = "fake-session";

out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: ["Read", "Bash"] });

function result(text: string, isError = false) {
  out({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    result: text,
    session_id: sessionId,
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 0 },
  });
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
if (mode === "rate_limited") {
  out({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1893456000, rateLimitType: "five_hour" },
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
if (mode === "argv") {
  result(JSON.stringify({ argv: process.argv.slice(2), stdin: await Bun.stdin.text() }));
  process.exit(0);
}

out({
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed", resetsAt: 1893456000, rateLimitType: "five_hour" },
});
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Looking at the repo." }] } });
out({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/README.md" } }] },
});
out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "# fixture" }] } });
result("All done.");
