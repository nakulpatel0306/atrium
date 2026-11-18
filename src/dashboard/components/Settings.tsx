import { navigate } from "../route";
import type { State } from "../api";
import { ArchivedSpaces } from "./ArchivedSpaces";
import { OldDataNotice } from "./OldData";
import { Profile } from "./Profile";
import { Storage } from "./Storage";

// Only an older install has anything here: what its removed features left, and the way to remove it.
export function DataSection({ oldData }: { oldData: State["oldData"] }) {
  if (!oldData.present) return null;
  return (
    <>
      <h2>Data</h2>
      <OldDataNotice />
    </>
  );
}

export function Settings({ state }: { state: State }) {
  return (
    <div className="wrap">
      <h1>Settings</h1>
      <p className="brief">Setup, your name and projects folder, archived spaces and storage.</p>
      {/* Where someone new looks first: the walk-through that opened on the first run, any time again. */}
      <h2>Get started</h2>
      <div className="set-card start-card">
        <p>Checks that Claude is ready, picks your projects folder and runs one small task, so you see the whole loop once.</p>
        <button className="btn" onClick={() => navigate("/start")}>
          Start
        </button>
      </div>
      <h2>You</h2>
      <Profile />
      <ArchivedSpaces />
      <Storage />
      <DataSection oldData={state.oldData} />
    </div>
  );
}
