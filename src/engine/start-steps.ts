import type { Report } from "./doctor";

// The Get started wizard's order. Only Claude (in "agents") can hold the wizard back from Done.
export const STEPS = ["welcome", "agents", "tools", "investing", "profile", "done"] as const;
export type Step = (typeof STEPS)[number];
export type Progress = { step: Step; skipped: Step[]; done: boolean };

export const isStep = (s: unknown): s is Step => (STEPS as readonly unknown[]).includes(s);

export const nextStep = (s: Step): Step => STEPS[Math.min(STEPS.indexOf(s) + 1, STEPS.length - 1)]!;
export const prevStep = (s: Step): Step => STEPS[Math.max(STEPS.indexOf(s) - 1, 0)]!;

// Claude is the one required tool: Done waits until it is installed, recent enough and not signed out.
export const claudeBlocks = (r: Report): string | null => {
  const c = r.agents.find((a) => a.id === "claude")!;
  return c.state === "ready" || c.state === "unknown" ? null : c.message;
};

// Whether the wizard needs Claude checked: only moving onto Done or finishing.
export const needsClaudeCheck = (c: { step?: unknown; done?: unknown }): boolean => c.step === "done" || c.done === true;
