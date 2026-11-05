import { CircleCheck, CircleDashed, CircleDot, CircleSlash, CircleX, LoaderCircle, type LucideIcon } from "lucide-react";
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

export function StatusIcon({ status }: { status: Status }) {
  const { icon: Icon, label } = ICONS[status];
  return (
    <Icon className={`stat ${status}`} role="img" aria-label={label}>
      <title>{label}</title>
    </Icon>
  );
}
