import type { Report } from "./doctor";

// The Get started wizard's order: only what coding needs. Claude is required; the projects folder comes prefilled; the
// sample task is offered last and can be skipped.
export const STEPS = ["claude", "folder", "sample"] as const;
export type Step = (typeof STEPS)[number];
export type Progress = { step: Step; skipped: Step[]; done: boolean; dismissed: boolean };

export const isStep = (s: unknown): s is Step => (STEPS as readonly unknown[]).includes(s);

export const nextStep = (s: Step): Step => STEPS[Math.min(STEPS.indexOf(s) + 1, STEPS.length - 1)]!;
export const prevStep = (s: Step): Step => STEPS[Math.max(STEPS.indexOf(s) - 1, 0)]!;

// Claude is the one required tool: the sample and finishing wait until it is installed, recent enough and signed in.
export const claudeBlocks = (r: Report): string | null => {
  const c = r.agents.find((a) => a.id === "claude")!;
  // "unknown" means the sign-in check itself failed; Done waits until one succeeds.
  return c.state === "ready" ? null : c.message;
};

// Whether the wizard needs Claude checked: moving past it, or finishing.
export const needsClaudeCheck = (c: { step?: unknown; done?: unknown }): boolean => (c.step !== undefined && c.step !== "claude") || c.done === true;
