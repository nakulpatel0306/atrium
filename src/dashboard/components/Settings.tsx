import { ArchivedSpaces } from "./ArchivedSpaces";
import { Profile } from "./Profile";
import { Storage } from "./Storage";

export function Settings() {
  return (
    <div className="wrap">
      <h1>Settings</h1>
      <p className="brief">Your name and projects folder, archived spaces and storage.</p>
      <h2>You</h2>
      <Profile />
      <ArchivedSpaces />
      <Storage />
    </div>
  );
}
