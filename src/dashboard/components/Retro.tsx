import { ChartNoAxesColumn, Compass } from "lucide-react";
import type { State } from "../api";

type Task = State["tasks"][number];

// The director retro on a task the user accepted or opened a pull request for: what Atrium measured (steers, rework, late failures, cost against similar
// tasks) and one suggestion picked by fixed rules from those numbers.
export function RetroCard({ task, state }: { task: Task; state: State }) {
  const retro = state.learning.retros[task.id];
  if (!retro) return null;
  return (
    <section className="retro">
      <h4>
        <Compass />
        How directing it went
      </h4>
      {retro.lines.map((l, i) => (
        <p key={i} className={i === 2 ? "retro-tip" : undefined}>
          {l}
        </p>
      ))}
    </section>
  );
}

// This week's roll-up for a space (or everything, on Home): only once there's enough to say anything.
export function RollupCard({ state, spaceId }: { state: State; spaceId: string | null }) {
  const r = state.learning.rollups[spaceId ?? "all"];
  if (!r) return null;
  return (
    <section className="rollup">
      <h4>
        <ChartNoAxesColumn />
        What paid off this week
        <span className="hint">measured on {r.tasks} finished tasks</span>
      </h4>
      <ul>
        {r.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}
