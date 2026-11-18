import type { State } from "./api";
import { needsCount } from "./components/NeedsYou";

// Plum's pose in the sidebar, from the engine's live state. Agents at work set the pose: a running agent is the thing
// that changes while you watch. The words always say what's waiting too, so the two never seem to disagree.
export type PlumPose = "work" | "look" | "quiet";

export function plumState(state: State): { pose: PlumPose; say: string } {
  const running = state.tasks.filter((t) => t.status === "running").length;
  const waiting = needsCount(state);
  const needs = waiting === 1 ? "1 needs you" : `${waiting} need you`;
  if (running > 0) return { pose: "work", say: waiting > 0 ? `${running} at work · ${needs}` : `${running} at work` };
  if (waiting > 0) return { pose: "look", say: needs };
  return { pose: "quiet", say: "All quiet" };
}
