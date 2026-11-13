import { patch, type State } from "./api";
import { showToast } from "./toast";

type Space = State["spaces"][number];

// The tag a space shows for its kind. General needs no tag; the stored kind names are internal.
export const kindLabel = (kind: Space["kind"]): string | null => (kind === "repo" ? "Code" : null);

// Archive and restore are the two reversible changes to a space, so each offers an Undo for a few seconds.
export async function setArchived(space: Pick<Space, "id" | "name">, archived: boolean): Promise<{ ok: boolean; error?: string }> {
  const flip = (to: boolean) => patch<Space>(`/api/spaces/${encodeURIComponent(space.id)}`, { status: to ? "archived" : "active" });
  const res = await flip(archived);
  if (!res.ok) return res;
  if (res.data.id !== space.id) {
    showToast(`Moved the earlier "${space.name}" into your current one, so there's only one.`);
    return { ok: true };
  }
  showToast(archived ? `Archived "${space.name}". It's in Settings under Archived spaces.` : `Restored "${space.name}".`, () => flip(!archived));
  return { ok: true };
}
