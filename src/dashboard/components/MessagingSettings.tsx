import { BookUser, MessageSquare, Settings2 } from "lucide-react";
import { useState } from "react";
import { post, useEngineState } from "../api";

type Messaging = NonNullable<ReturnType<typeof useEngineState>>["messaging"];

export function sendingLine(state: Messaging["state"]): { text: string; tone: "ok" | "bad" | null } {
  if (state === "ready") return { text: "Working. Atrium last sent a text without trouble.", tone: "ok" };
  if (state === "needs_automation") return { text: 'Blocked. In System Settings › Privacy & Security › Automation, turn on Messages under "bun" (Atrium\'s engine).', tone: "bad" };
  if (state === "signed_out") return { text: "Blocked. Messages isn't signed in to iMessage on this Mac.", tone: "bad" };
  return { text: "Not tried yet. The first send asks macOS whether Atrium may control Messages.", tone: null };
}

export function contactsLine(ready: boolean | null): { text: string; tone: "ok" | "bad" | null } {
  if (ready === true) return { text: "Allowed. Atrium looks people up when it drafts a text.", tone: "ok" };
  if (ready === false) return { text: 'Not allowed. Type numbers yourself, or turn on Contacts under "bun" in System Settings › Privacy & Security › Automation.', tone: "bad" };
  return { text: "Not tried yet. Atrium only looks after you press Look up on a text.", tone: null };
}

// How texts leave the Mac, and the one System Settings pane that controls it.
export function MessagingSettings() {
  const state = useEngineState();
  const [error, setError] = useState<string | null>(null);
  if (!state) return null;
  const sending = sendingLine(state.messaging.state);
  const contacts = contactsLine(state.messaging.contactsReady);
  const open = async () => {
    const res = await post("/api/messaging/open-settings", { pane: "automation" });
    setError(res.ok ? null : res.error);
  };
  return (
    <>
      <h2>Messages</h2>
      <p className="brief">Atrium sends texts from the Messages app on this Mac, and only after you press Send on a text in Needs you. Every text asks, every time.</p>
      <div className="list">
        <div className="item set-row">
          <MessageSquare />
          <span className="who">Sending</span>
          <span className={`t${sending.tone ? ` ${sending.tone}` : ""}`}>{sending.text}</span>
        </div>
        <div className="item set-row">
          <BookUser />
          <span className="who">Contacts</span>
          <span className={`t${contacts.tone ? ` ${contacts.tone}` : ""}`}>{contacts.text}</span>
        </div>
      </div>
      <div className="mk-form">
        <button className="btn" type="button" onClick={() => void open()}>
          <Settings2 />
          Open System Settings
        </button>
        {error ? <span className="err">{error}</span> : <span className="faint">Privacy & Security › Automation, where macOS lists what Atrium may control.</span>}
      </div>
    </>
  );
}
