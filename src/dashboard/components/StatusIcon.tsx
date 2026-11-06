import { CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleSlash, CircleX, LoaderCircle, type LucideIcon } from "lucide-react";
import type { Outcome } from "../../engine/outcome";
import type { State } from "../api";

type Status = State["tasks"][number]["status"];

// One circle family so every status reads as the same kind of thing; the inner mark and color tell them apart.
const ICONS: Record<Status, { icon: LucideIcon; label: string }> = {
  queued: { icon: CircleDashed, label: "Queued" },
  running: { icon: LoaderCircle, label: "Running" },
  review: { icon: CircleDot, label: "Ready for your review" },
  blocked: { icon: CircleSlash, label: "Blocked" },
  failed: { icon: CircleX, label: "Failed" },
  done: { icon: CircleCheck, label: "Done" },
};

// A finished task the agent said it couldn't or only partly do never wears the done check.
const UNFINISHED = {
  couldnt: { icon: CircleAlert, label: "Not done", cls: "notdone" },
  partial: { icon: CircleDashed, label: "Partly done", cls: "partial" },
} as const;

export function StatusIcon({ status, outcome = null }: { status: Status; outcome?: Outcome | null }) {
  const odd = status === "done" && (outcome === "couldnt" || outcome === "partial") ? UNFINISHED[outcome] : null;
  const { icon: Icon, label } = odd ?? ICONS[status];
  return (
    <Icon className={`stat ${odd?.cls ?? status}`} role="img" aria-label={label}>
      <title>{label}</title>
    </Icon>
  );
}
