import { describe, expect, test } from "bun:test";
import { createTask, setTaskLoop } from "../../src/engine/tasks";
import { newLoop, resumed, SIZE_BUDGETS } from "../../src/engine/loop";
import { setSetting } from "../../src/engine/settings";
import { setTierModel, STRONG_FALLBACK, TIER_DEFAULTS, tierModel, tierRun } from "../../src/engine/tiers";
import { fake, loopHarness, ok, waitFor, writer } from "./loop-harness";

const h = loopHarness();

describe("tiers", () => {
  test("defaults work on a plain subscription: the writer keeps the user's own model", () => {
    expect(tierModel(h.db, "cheap")).toBe("haiku");
    expect(tierRun(h.db, "default")).toEqual({});
    expect(tierRun(h.db, "strong")).toEqual({ model: "opus", fallbackModel: STRONG_FALLBACK });
  });

  test("each tier's model can be changed, and a stored value that isn't a model name reads as the default", () => {
    setTierModel(h.db, "default", "sonnet");
    expect(tierRun(h.db, "default")).toEqual({ model: "sonnet" });
    expect(() => setTierModel(h.db, "cheap", "--dangerously-skip-permissions")).toThrow();
    setSetting(h.db, "tiers.strong", "-x");
    expect(tierModel(h.db, "strong")).toBe(TIER_DEFAULTS.strong);
  });

  test("a Claude reviewer runs on the strong tier and the writer on the default one", async () => {
    const path = h.repo();
    const s = h.space(path, { reviewBy: "claude" });
    const t = createTask(h.db, { spaceId: s.id, title: "Add totals" });
    const claude = writer(["pass"]);
    h.start({ claude: claude.adapter });
    await waitFor(() => h.status(t.id) === "review");
    const [write, review] = claude.calls;
    expect(write!.model).toBeUndefined();
    expect(review!.mode).toBe("review");
    expect(review!.model).toBe("opus");
    expect(review!.fallbackModel).toBe(STRONG_FALLBACK);
  });

  test("a writer the user unsticks after a pause goes on with the strong model; an explanation uses the cheap one", async () => {
    const path = h.repo();
    const s = h.space(path);
    const t = createTask(h.db, { spaceId: s.id, title: "Add totals" });
    const paused = { ...newLoop(SIZE_BUDGETS.small), paused: { kind: "loop" as const, diagnosis: "It looped." } };
    setTaskLoop(h.db, t.id, { ...paused, explain: true });
    h.db.query("UPDATE tasks SET status = 'queued' WHERE id = ?").run(t.id);
    const claude = fake("claude", (input) => ok(input.mode === "review" ? "Because.\nOUTCOME: done" : "Fixed.\nOUTCOME: done"));
    h.start({ claude: claude.adapter });
    await waitFor(() => h.status(t.id) === "blocked");
    expect(claude.calls[0]!.model).toBe("haiku");
    expect(resumed(paused).escalated).toBe(true);
    expect(resumed(newLoop(SIZE_BUDGETS.small)).escalated).toBe(false);
  });
});
