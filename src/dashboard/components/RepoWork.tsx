import { useEffect, useState } from "react";
import type { State } from "../api";
import type { ChangeSpot } from "../route";
import { ChangesView } from "./ChangesView";
import { PullRequest } from "./PullRequest";
import { SteerTask } from "./SteerTask";
import { WalkthroughCard } from "./Walkthrough";
import { WhatItMade } from "./WhatItMade";

type Task = State["tasks"][number];
type Space = State["spaces"][number];
export type WorkView = "made" | "changes";

// A repo task's detail: the walkthrough of a finished change above the agent's changes and What it made, a note to
// steer it while it runs, and a pull request once it's finished. While it runs the changes are what's worth watching,
// so they open first; a walkthrough's link opens them at its hunk.
export function RepoWork({ task, space, agent, initial, at = null }: { task: Task; space: Space; agent: string; initial?: WorkView; at?: ChangeSpot | null }) {
  const [view, setView] = useState<WorkView>(initial ?? (at || task.status === "running" ? "changes" : "made"));
  useEffect(() => {
    if (at) setView("changes");
  }, [at?.file, at?.line]);
  return (
    <>
      <SteerTask task={task} />
      <WalkthroughCard task={task} space={space} />
      <div className="tabs work-tabs" role="tablist">
        <button role="tab" aria-selected={view === "made"} className={view === "made" ? "on" : ""} onClick={() => setView("made")}>
          What it made
        </button>
        <button role="tab" aria-selected={view === "changes"} className={view === "changes" ? "on" : ""} onClick={() => setView("changes")}>
          Changes
        </button>
      </div>
      {view === "changes" ? <ChangesView task={task} agent={agent} at={at} /> : <WhatItMade taskId={task.id} spaceId={space.id} spaceKind={space.kind} noChanges={task.loop?.noChanges} />}
      {(task.status === "review" || task.status === "done") && task.kind === "work" && <PullRequest task={task} />}
    </>
  );
}
