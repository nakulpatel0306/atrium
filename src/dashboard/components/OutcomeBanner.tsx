import { CircleAlert, CircleDashed, CircleHelp } from "lucide-react";
import type { Outcome } from "../../engine/outcome";

// What the agent said about a result that isn't plainly done, shown above anything else about it.
export function outcomeText(outcome: Outcome | null, reason: string | null): string | null {
  if (outcome === "couldnt") return `Couldn't do this: ${reason ?? "The agent didn't say why."}`;
  if (outcome === "partial") return `Partly done: ${reason ?? "The agent didn't say what's left."}`;
  if (outcome === "unknown") return "Atrium can't tell whether this was done. The agent didn't say, so check the summary.";
  return null;
}

export const approveLabel = (outcome: Outcome | null): string =>
  outcome === "couldnt" ? "Accept anyway" : outcome === "partial" ? "Accept as is" : "Approve";

const ICONS = { couldnt: CircleAlert, partial: CircleDashed, unknown: CircleHelp } as const;

export function OutcomeBanner({ outcome, reason }: { outcome: Outcome | null; reason: string | null }) {
  const text = outcomeText(outcome, reason);
  if (!text || !outcome || outcome === "done") return null;
  const Icon = ICONS[outcome];
  return (
    <p className={`outcome-banner ${outcome}`} role="note">
      <Icon />
      <span>{text}</span>
    </p>
  );
}
