import { CircleAlert, CircleCheck, CircleDashed, CircleDot, CirclePause, CircleSlash, CircleX, LoaderCircle, type LucideIcon } from "lucide-react";
import type { Outcome } from "../../engine/outcome";
import type { State } from "../api";

type Status = State["tasks"][number]["status"];

// One circle family so every status reads as the same kind of thing; the inner mark and color tell them apart.
const ICONS: Record<Status, { icon: LucideIcon; label: string }> = {
  queued: { icon: CircleDashed, label: "Queued" },
  running: { icon: LoaderCircle, label: "Running" },
  review: { icon: CircleDot, label: "Ready for review" },
  blocked: { icon: CircleSlash, label: "Stopped" },
  failed: { icon: CircleX, label: "Failed" },
  done: { icon: CircleCheck, label: "Done" },
};

// A finished task the agent said it couldn't or only partly do never wears the done check.
const UNFINISHED = {
  couldnt: { icon: CircleAlert, label: "Not done", cls: "notdone" },
  partial: { icon: CircleDashed, label: "Partly done", cls: "partial" },
} as const;

// A stopped task the loop paused itself waits for a hint, not a retry, and says so (engine/words.ts).
const PAUSED = { icon: CirclePause, label: "Paused", cls: "paused" } as const;

export function StatusIcon({ status, outcome = null, paused = false }: { status: Status; outcome?: Outcome | null; paused?: boolean }) {
  const odd = status === "done" && (outcome === "couldnt" || outcome === "partial") ? UNFINISHED[outcome] : status === "blocked" && paused ? PAUSED : null;
  const { icon: Icon, label } = odd ?? ICONS[status];
  return (
    <Icon className={`stat ${odd?.cls ?? status}`} role="img" aria-label={label}>
      <title>{label}</title>
    </Icon>
  );
}
