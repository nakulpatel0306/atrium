import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { ACTIVITY_MORE, ACTIVITY_PAGE, type ActivityGroup, byDay, groupActivity } from "../../engine/activity-groups";
import type { State } from "../api";
import { absolute, clock, relative } from "../format";
import { actorName } from "../summary";

type Task = State["tasks"][number];

// Today's lines say how long ago; older days already have their date above, so they show the time.
const when = (g: ActivityGroup) => (g.day === "Today" ? relative(g.at) : clock(g.at));

function Group({ group, spaceName, showTitle = true }: { group: ActivityGroup; spaceName: string | undefined; showTitle?: boolean }) {
  const [open, setOpen] = useState(false);
  // A task's folded line leads with the task; a line of its own already names it.
  const lead = showTitle && group.title && (group.events.length > 1 || !group.text.includes(group.title)) ? group.title : null;
  const src = [spaceName, lead ?? (group.title ? null : actorName(group.actor))].filter(Boolean).join(" · ");
  return (
    <div className={`group tone-${group.tone}${open ? " open" : ""}`}>
      <button className="item" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tm" title={absolute(group.at)}>
          {when(group)}
        </span>
        <span className="mark" aria-hidden />
        <span className="msg">
          {src && <span className="src">{src}</span>}
          {src && " · "}
          {group.text}
        </span>
        {group.count > 1 && (
          <span className="more-n" title={`${group.count} lines`}>
            {group.count}
            <ChevronRight />
          </span>
        )}
      </button>
      {open && (
        <ul className="events">
          {group.events.map((e) => (
            <li key={e.id}>
              <span className="tm" title={absolute(e.createdAt)}>
                {clock(e.createdAt)}
              </span>
              <span>
                <span className="src">{actorName(e.actor)}</span>: {e.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Feed({ groups, names, showTitle }: { groups: ActivityGroup[]; names?: Map<string, string>; showTitle?: boolean }) {
  const [shown, setShown] = useState(ACTIVITY_PAGE);
  return (
    <>
      {byDay(groups.slice(0, shown)).map((d) => (
        <div key={d.dayKey} className="day">
          <div className="day-head">{d.day}</div>
          {d.groups.map((g) => (
            <Group key={g.id} group={g} spaceName={g.spaceId ? names?.get(g.spaceId) : undefined} showTitle={showTitle} />
          ))}
        </div>
      ))}
      {groups.length > shown && (
        <button className="btn link show-more" onClick={() => setShown(shown + ACTIVITY_MORE)}>
          Show more · {groups.length - shown} earlier
        </button>
      )}
    </>
  );
}

const contextOf = (state: State) => ({ tasks: state.tasks, files: state.activityFiles });

// With a spaceId, shows only that space's lines and drops the space name each line would repeat.
export function Activity({ state, spaceId }: { state: State; spaceId?: string }) {
  const names = new Map(state.spaces.map((s) => [s.id, s.name]));
  const rows = spaceId ? state.activity.filter((r) => r.spaceId === spaceId) : state.activity;
  const groups = groupActivity(rows, contextOf(state));
  return (
    <>
      <h2 id="activity">Activity</h2>
      <div className="list feed">
        {groups.length === 0 ? (
          <div className="empty-row">No activity yet. Agent runs and your decisions will show up here.</div>
        ) : (
          <Feed key={spaceId ?? "all"} groups={groups} names={spaceId ? undefined : names} />
        )}
      </div>
    </>
  );
}

// One task's lines, folded the same way, for its detail.
export function TaskHistory({ task, state }: { task: Task; state: State }) {
  const groups = groupActivity(
    state.activity.filter((r) => r.spaceId === task.spaceId),
    contextOf(state),
  ).filter((g) => g.taskId === task.id || (g.taskId === null && g.title === task.title));
  if (groups.length === 0) return null;
  return (
    <section className="history">
      <h4>History</h4>
      <div className="feed">
        <Feed groups={groups} showTitle={false} />
      </div>
    </section>
  );
}
