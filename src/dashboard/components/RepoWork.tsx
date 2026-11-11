import { useState } from "react";
import type { State } from "../api";
import { ChangesView } from "./ChangesView";
import { PullRequest } from "./PullRequest";
import { SteerTask } from "./SteerTask";
import { WhatItMade } from "./WhatItMade";

type Task = State["tasks"][number];
type Space = State["spaces"][number];
export type WorkView = "made" | "changes";

// A repo task's detail: the agent's changes next to What it made, a note to steer it while it runs, and a pull
// request once it's finished. While it runs the changes are what's worth watching, so they open first.
export function RepoWork({ task, space, agent, initial }: { task: Task; space: Space; agent: string; initial?: WorkView }) {
  const [view, setView] = useState<WorkView>(initial ?? (task.status === "running" ? "changes" : "made"));
  return (
    <>
      <SteerTask task={task} />
      <div className="tabs work-tabs" role="tablist">
        <button role="tab" aria-selected={view === "made"} className={view === "made" ? "on" : ""} onClick={() => setView("made")}>
          What it made
        </button>
        <button role="tab" aria-selected={view === "changes"} className={view === "changes" ? "on" : ""} onClick={() => setView("changes")}>
          Changes
        </button>
      </div>
      {view === "changes" ? <ChangesView task={task} agent={agent} /> : <WhatItMade taskId={task.id} spaceId={space.id} spaceKind={space.kind} />}
      {(task.status === "review" || task.status === "done") && task.kind === "work" && <PullRequest task={task} />}
    </>
  );
}
