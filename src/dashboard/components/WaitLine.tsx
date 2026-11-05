import { Clock, Gauge, Hourglass, LogIn, type LucideIcon, PackageX, PlugZap, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { needsAction, type Wait, type WaitKind } from "../agents";

export const WAIT_ICONS: Record<WaitKind, LucideIcon> = {
  power: PlugZap,
  reserve: Gauge,
  limit: Hourglass,
  "signed-out": LogIn,
  missing: PackageX,
  guard: ShieldAlert,
  other: Clock,
};

// Engine messages quote commands in backticks ("run `codex login`"); show those as code.
export function Plain({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

export function WaitLine({ wait, children }: { wait: Wait; children?: ReactNode }) {
  const Icon = WAIT_ICONS[wait.kind];
  return (
    <p className={`why ${needsAction(wait) ? "bad" : "waiting"}`}>
      <Icon />
      <span>
        <Plain text={wait.text} />
      </span>
      {children}
    </p>
  );
}
