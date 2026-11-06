import { CircleAlert, CircleDashed, CircleHelp } from "lucide-react";
import { type Outcome, outcomeText } from "../../engine/outcome";

export { outcomeText };

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
