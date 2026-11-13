import { Clock, Download, FileKey, Gauge, Hourglass, ListChecks, Lock, LogIn, type LucideIcon, PackageX, MessageCircleQuestion, PlugZap, SearchCheck, ShieldAlert, Split } from "lucide-react";
import type { ReactNode } from "react";
import { needsAction, type Wait, type WaitKind } from "../agents";

export const WAIT_ICONS: Record<WaitKind, LucideIcon> = {
  power: PlugZap,
  reserve: Gauge,
  limited: Hourglass,
  signed_out: LogIn,
  not_installed: PackageX,
  private_space: Lock,
  env_files: FileKey,
  gemini_repo: ShieldAlert,
  cloning: Download,
  busy: Clock,
  reviewing: SearchCheck,
  answers: MessageCircleQuestion,
  shape: Split,
  parts: ListChecks,
  pick: ListChecks,
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
        <Plain text={wait.reason} />
      </span>
      {children}
    </p>
  );
}
