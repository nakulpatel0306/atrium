import type { State } from "../api";
import { plumState } from "../plum";

// A small Plum at the foot of the sidebar, in the pose that matches what Atrium is doing. The pictures are stills of
// the site's 3D Plum (assets/plum), so the dashboard loads no 3D library and draws no WebGL. It isn't a live region:
// the page already announces what changes, and Plum would only say it again.
export function PlumStatus({ state }: { state: State }) {
  const { pose, say } = plumState(state);
  return (
    <div className="plum-status" data-pose={pose}>
      <span className="plum-pic" aria-hidden="true" />
      <span className="label">
        {say.split(" · ").map((part, i) => (
          <span key={part} className="plum-line">
            {i === 0 && pose !== "quiet" && <span className="plum-dot" aria-hidden="true" />}
            {part}
          </span>
        ))}
      </span>
    </div>
  );
}
