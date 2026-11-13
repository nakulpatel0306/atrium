import { Database } from "lucide-react";
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
      <h2>
        <Database />
        Data
      </h2>
      <OldDataNotice />
    </>
  );
}

export function Settings({ state }: { state: State }) {
  return (
    <div className="wrap">
      <h1>Settings</h1>
      <p className="brief">Your name and projects folder, archived spaces and storage.</p>
      <h2>You</h2>
      <Profile />
      <ArchivedSpaces />
      <Storage />
      <DataSection oldData={state.oldData} />
    </div>
  );
}
