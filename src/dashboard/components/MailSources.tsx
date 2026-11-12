import { CalendarDays, Mail, Settings2 } from "lucide-react";
import { useState } from "react";
import { post } from "../api";
import { announce } from "../live";
import type { MailOverview } from "../mail";

// The three optional sources, set up the same way from Get started and from Settings → Accounts.

export function GoogleConnect({ overview }: { overview: MailOverview }) {
  const [clientId, setClientId] = useState(overview.google.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    const res = await post<{ url: string }>("/api/mail/google/connect", { clientId, clientSecret: secret || undefined });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setSecret("");
    setLink(res.data.url);
    announce("Google sign-in opened in your browser.");
  };
  const google = overview.accounts.filter((a) => a.source === "google");
  return (
    <div className="set-card">
      <div className="set-title">
        <b>Google</b>
        <span className="tag">Optional</span>
        {google.length > 0 && <span className="tag ok">{google.length === 1 ? "1 account" : `${google.length} accounts`}</span>}
      </div>
      <p className="hint">Gmail and Google Calendar, read straight from Google. You use your own Google Cloud OAuth client, so no one else's app ever holds your mail. Sign-in tokens stay in your Mac's Keychain.</p>
      <details className="mail-steps">
        <summary>How to get a client ID (about 5 minutes)</summary>
        <ol>
          <li>Open console.cloud.google.com, create a project, and turn on the Gmail API and the Google Calendar API.</li>
          <li>Under Google Auth Platform, set up the consent screen as External, and add your own address as a test user.</li>
          <li>Under Clients, create an OAuth client of type Desktop app.</li>
          <li>Paste its client ID below, and its client secret if it shows one. Then press Connect Google and sign in.</li>
        </ol>
        <p className="hint">The full guide is docs/google-setup.md in the Atrium folder.</p>
      </details>
      <form
        className="mk-form"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <label>
          Client ID
          <input className="mk-input mail-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" spellCheck={false} autoComplete="off" />
        </label>
        <label>
          Client secret
          <input className="mk-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="If Google gave you one" autoComplete="off" />
        </label>
        <button className="btn p" type="submit" disabled={busy || !clientId.trim()}>
          {google.length ? "Connect another Google account" : "Connect Google"}
        </button>
      </form>
      {error && <p className="err">{error}</p>}
      {overview.google.connecting && link && (
        <p className="hint" role="status">
          Finish signing in in your browser. If it didn't open, copy this link into it: <code className="mail-link">{link}</code>
        </p>
      )}
      {!overview.google.connecting && overview.google.lastError && <p className="err">{overview.google.lastError}</p>}
    </div>
  );
}

const APPLE = {
  mail: {
    title: "Apple Mail",
    icon: Mail,
    about: "Every account in the Mail app on this Mac: iCloud, Outlook, Exchange and others. Atrium reads your inbox and sent mail through Mail itself.",
    ask: 'macOS will ask whether "bun" (Atrium\'s engine) may control Mail. Choose Allow.',
    pane: "automation",
  },
  calendar: {
    title: "Apple Calendar",
    icon: CalendarDays,
    about: "Every calendar in the Calendar app: iCloud, synced Google or Exchange calendars, and subscriptions.",
    ask: "macOS will ask whether Atrium may see your calendars. Choose Allow Full Access.",
    pane: "calendars",
  },
} as const;

export function AppleSource({ what, overview }: { what: "mail" | "calendar"; overview: MailOverview }) {
  const c = APPLE[what];
  const on = overview.apple[what];
  const problem = what === "mail" ? overview.apple.mailProblem : overview.apple.calendarProblem;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (value: boolean) => {
    setBusy(true);
    const res = await post("/api/mail/apple", { what, on: value });
    setBusy(false);
    setAsking(false);
    setError(res.ok ? null : res.error);
    if (res.ok) announce(value ? `${c.title} is on.` : `${c.title} is off.`);
  };
  const openSettings = async () => {
    const res = await post("/api/mail/open-settings", { pane: c.pane });
    if (!res.ok) setError(res.error);
  };
  const Icon = c.icon;
  return (
    <div className="set-card">
      <div className="set-title">
        <Icon aria-hidden />
        <b>{c.title}</b>
        <span className="tag">Optional</span>
        {on && <span className={`tag${problem ? " bad" : " ok"}`}>{problem ? "Needs attention" : "On"}</span>}
      </div>
      <p className="hint">{c.about}</p>
      {!overview.apple.installed && <p className="hint">This needs Atrium's Mail and Calendar helper, which comes with the Mac app: run atrium app install in Terminal first.</p>}
      {(problem || error) && <p className="err">{error ?? problem}</p>}
      {asking ? (
        <div className="mk-form" role="group" aria-label={`Allow ${c.title}`}>
          <p className="hint">{c.ask}</p>
          <button className="btn" onClick={() => setAsking(false)}>
            Cancel
          </button>
          <button className="btn p" disabled={busy} onClick={() => void set(true)}>
            {busy ? "Waiting for macOS…" : "Continue"}
          </button>
        </div>
      ) : (
        <div className="mk-form">
          {on ? (
            <button className="btn" disabled={busy} onClick={() => void set(false)}>
              Turn off
            </button>
          ) : (
            <button className="btn p" disabled={!overview.apple.installed} onClick={() => setAsking(true)}>
              Allow {c.title}
            </button>
          )}
          {(problem || error) && (
            <button className="btn" onClick={() => void openSettings()}>
              <Settings2 />
              Open System Settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}
