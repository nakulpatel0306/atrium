import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROACH_FIRST } from "../../src/engine/runner";
import { updateSpace } from "../../src/engine/spaces";
import { createTask } from "../../src/engine/tasks";
import { fake, loopHarness, ok, waitFor } from "./loop-harness";

// The learning features inside the loop: the walkthrough after a result, the writer's approach in deep mode, the
// retro's tally, and the curator after repeated review findings. None of them adds a step before the result.
const h = loopHarness();
const CHEAP = readFileSync(join(import.meta.dir, "..", "fixtures", "learning", "walkthrough-cheap.txt"), "utf8").replaceAll("src/cart.ts", "work.txt");
const isWalkthrough = (system: string) => system.startsWith("You explain a finished code change");
const isMemory = (system: string) => system.startsWith("You help the user keep a repo's CLAUDE.md");

// A writer whose turns leave status.txt as listed, a reviewer whose replies come in order, and the cheap tier's
// walkthrough and memory replies.
function agents(statuses: string[], reviews: string[] = ["VERDICT: approve"], memory = "NONE") {
  let turn = 0;
  let round = 0;
  return fake("claude", (input) => {
    if (isWalkthrough(input.systemPrompt)) return ok(CHEAP);
    if (isMemory(input.systemPrompt)) return ok(memory);
    if (input.mode === "review") return ok(reviews[Math.min(round++, reviews.length - 1)]!);
    turn++;
    writeFileSync(join(input.cwd, "status.txt"), `${statuses[Math.min(turn, statuses.length) - 1]}\n`);
    writeFileSync(join(input.cwd, "work.txt"), `turn ${turn}\n`);
    return ok("Changed it.\nOUTCOME: done");
  });
}

test("with review off, the result reaches the user first and the cheap tier's walkthrough follows, with no tools", async () => {
  const s = updateSpace(h.db, h.space(h.repo()).id, { learning: "light" });
  const t = createTask(h.db, { spaceId: s.id, title: "Cart" });
  const claude = agents(["pass"]);
  h.start({ claude: claude.adapter });
  await waitFor(() => h.status(t.id) === "review");
  await waitFor(() => h.task(t.id).loop!.walkthrough !== null);
  const w = h.task(t.id).loop!.walkthrough!;
  expect([w.source, w.sha]).toEqual(["cheap", h.task(t.id).loop!.checkedSha]);
  const call = claude.calls.find((c) => isWalkthrough(c.systemPrompt))!;
  expect(call).toMatchObject({ allowedTools: [], mode: "review", model: "haiku" });
  // The writer in light mode isn't asked for its approach first.
  expect(claude.calls[0]!.prompt).not.toContain(APPROACH_FIRST);
});

test("a reviewer that writes the walkthrough saves the extra call, and deep mode asks the writer for its approach first", async () => {
  const s = updateSpace(h.db, h.space(h.repo(), { reviewBy: "claude" }).id, { learning: "deep" });
  const t = createTask(h.db, { spaceId: s.id, title: "Cart" });
  const claude = agents(["pass"], [`${CHEAP}\nVERDICT: approve`]);
  h.start({ claude: claude.adapter });
  await waitFor(() => h.status(t.id) === "review");
  expect(h.task(t.id).loop!.walkthrough).toMatchObject({ source: "review", by: "claude" });
  expect(claude.calls[0]!.prompt).toContain(APPROACH_FIRST);
  // The review asked for the question too.
  expect(claude.calls[1]!.prompt).toContain("PREDICT");
  await Bun.sleep(50);
  expect(claude.calls.some((c) => isWalkthrough(c.systemPrompt))).toBe(false);
});

test("the tally counts turns sent back for failing checks, a check that broke after passing, and review rounds", async () => {
  const s = h.space(h.repo(), { reviewBy: "claude" });
  const t = createTask(h.db, { spaceId: s.id, title: "Cart" });
  // Passes, the review asks for changes, the fix breaks the check that had passed, then passes again.
  const claude = agents(["pass", "wrong", "pass"], ["FINDING medium work.txt:1 off by one\nVERDICT: changes", "VERDICT: approve"]);
  h.start({ claude: claude.adapter });
  await waitFor(() => h.status(t.id) === "review", 15_000);
  expect(h.task(t.id).loop!.tally).toEqual({ steers: 0, checkFails: 1, lateFails: 1, reviewRounds: 1 });
});
