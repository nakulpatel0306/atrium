import type { State } from "../api";
import { agentText } from "../agents";
import { isRisky } from "../queue";
import type { ChangeSpot } from "../route";
import { ChangesView } from "./ChangesView";
import { DecisionBar, OpenPoints } from "./Decision";
import { LoopPanel, StageStrip } from "./LoopPanel";
import { Markdown } from "./Markdown";
import { OutcomeBanner } from "./OutcomeBanner";
import { RetroCard } from "./Retro";
import { WalkthroughCard } from "./Walkthrough";
import { WhatItMade } from "./WhatItMade";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Approval = State["approvals"][number];

type Props = { approval: Approval; task: Task | undefined; space: Space | undefined; state: State; armed?: boolean; keys?: boolean; at?: ChangeSpot | null };

// A result or question decided with everything it rests on in view, the diff included. Needs you and a task's own page
// both decide through this, so a result shows the same evidence wherever it's decided.
export function ResultDecision({ approval, task, space, state, armed = false, keys = false, at = null }: Props) {
  const outcome = task?.outcome && task.outcome !== "done" ? task.outcome : null;
  const repo = space?.kind === "repo";
  const diff = repo && task?.branch && approval.kind === "review" && !task.loop?.noChanges;
  const risky = isRisky(state, approval);
  return (
    <>
      {/* Where it is first, as on a paused item's screen: then the decision, its reasons and its evidence. */}
      {repo && task?.loop && !task.loop.fanout && <StageStrip task={task} />}
      <div className="dp-acts">
        <DecisionBar approval={approval} state={state} armed={armed} keys={keys} />
      </div>
      {/* Why a risky result asks for a look, before anything else on its screen. */}
      {task && risky && <OpenPoints task={task} />}
      {task?.loop?.noChanges ? (
        // Said plainly: an empty result has no commits to read or push, whatever the agent's own words were.
        <p className="dp-lead" role="note">
          It made no changes: its branch holds nothing new.
        </p>
      ) : (
        outcome && <OutcomeBanner outcome={outcome} reason={task?.outcomeReason ?? null} />
      )}
      {task && space ? (
        <>
          {/* What changed and where to look first leads; the diff itself next; the brief, checks and findings after. */}
          <WalkthroughCard task={task} space={space} />
          {diff && <ChangesView task={task} agent={agentText(task, state.runs)} at={at} />}
          {task.loop && <LoopPanel task={task} state={state} repo={repo} showChecks={task.loop.checks === "failed"} briefOpen={!diff} reasonsAbove={risky} strip={false} />}
          <RetroCard task={task} state={state} />
          {!diff && <WhatItMade taskId={task.id} spaceId={space.id} spaceKind={space.kind} noChanges={task.loop?.noChanges} />}
        </>
      ) : (
        <Markdown text={approval.detail || "No further detail."} />
      )}
    </>
  );
}
