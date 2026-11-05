import type { StorageView } from "../engine/repos";
import type { ProjectDraft } from "../engine/repos/names";
import { descriptionProblem, nameProblem, TEMPLATE_LABELS } from "../engine/repos/rules";
import { bytes, relative } from "./format";

export const draftErrors = (d: { name: string; description: string }) => ({
  name: nameProblem(d.name),
  description: descriptionProblem(d.description),
});

// The engine sends absolute paths; macOS homes live at /Users/<name>.
export const tildeShown = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

export const folderFor = (path: string, name: string) => `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;

export const draftSummary = (d: ProjectDraft) =>
  `Create GitHub repo "${d.name}"? · ${d.visibility === "public" ? "Public" : "Private"} · ${TEMPLATE_LABELS[d.template]}`;

// The removal's detail starts "<folder> · <size>.", written by the engine when it asked.
export const removalSize = (detail: string): string | null => /^[^·\n]+· ([\d.]+ [KMG]B)\./.exec(detail)?.[1] ?? null;

export function storageRow(r: StorageView["repos"][number], now = Date.now()) {
  const reasons = r.removable && !r.removable.ok ? r.removable.reasons : [];
  const status =
    r.createdBy === "you"
      ? "Kept"
      : r.pendingApprovalId
        ? "Waiting for you in Needs you"
        : r.removable?.ok
          ? "Can be removed"
          : (reasons[0] ?? "Checking…");
  return {
    name: r.spaceName,
    path: tildeShown(r.path),
    size: bytes(r.bytes),
    owner: r.createdBy === "atrium" ? "Made by Atrium" : "Yours, never removed",
    lastUsed: r.lastUsedAt === null ? "—" : relative(r.lastUsedAt, now),
    status,
    reasons,
    canAsk: r.createdBy === "atrium" && !r.pendingApprovalId && r.removable?.ok === true,
  };
}
