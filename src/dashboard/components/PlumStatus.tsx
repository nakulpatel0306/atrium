import type { State } from "../api";
import { plumState } from "../plum";

// A small Plum at the foot of the sidebar, in the pose that matches what Atrium is doing. The pictures are stills of
// the site's 3D Plum (assets/plum), so the dashboard loads no 3D library and draws no WebGL.
export function PlumStatus({ state }: { state: State }) {
  const { pose, say } = plumState(state);
  return (
    <div className="plum-status" data-pose={pose} role="status">
      <span className="plum-pic" aria-hidden="true" />
      <span className="label">
        {pose !== "quiet" && <span className="plum-dot" aria-hidden="true" />}
        {say}
      </span>
    </div>
  );
}
