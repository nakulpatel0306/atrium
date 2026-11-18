import type { State } from "./api";
import { needsCount } from "./components/NeedsYou";

// Plum's pose in the sidebar, from the engine's live state. Agents at work come first: the Needs you badge already
// counts what's waiting, and a running agent is the thing that changes while you watch.
export type PlumPose = "work" | "look" | "quiet";

export function plumState(state: State): { pose: PlumPose; say: string } {
  const running = state.tasks.filter((t) => t.status === "running").length;
  if (running > 0) return { pose: "work", say: `${running} at work` };
  const waiting = needsCount(state);
  if (waiting > 0) return { pose: "look", say: waiting === 1 ? "1 needs you" : `${waiting} need you` };
  return { pose: "quiet", say: "All quiet" };
}
