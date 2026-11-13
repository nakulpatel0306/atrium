import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { config } from "../config";
import { getSetting } from "../settings";
import { CLIENT_ID_KEY } from "./google/oauth";
import { PIM_COPY } from "./pim";
import { inboxSpaceId } from "./space";
import { listAccounts } from "./store";
import { appleOn, appleProblem } from "./sync";

// What Get started and `atrium doctor` say about each mail and calendar source. Read from the database and the disk
// only: no Keychain, no helper run (which could raise a permission prompt), no network.
export type MailSourceLine = { id: "google" | "helper" | "apple_mail" | "apple_calendar"; label: string; ready: boolean; message: string };
export type MailReport = { spaceId: string | null; clientId: boolean; sources: MailSourceLine[] };

export function mailReport(db: Database | null): MailReport {
  const accounts = db ? listAccounts(db) : [];
  const google = accounts.filter((a) => a.source === "google");
  const signedOut = google.filter((a) => a.status === "signed_out");
  const helper = existsSync(config().pimBin);
  const apple = (what: "mail" | "calendar", label: string): MailSourceLine => {
    const on = db ? appleOn(db, what) : false;
    const problem = db ? appleProblem(db, what) : null;
    return {
      id: what === "mail" ? "apple_mail" : "apple_calendar",
      label,
      ready: on && !problem && helper,
      message: !db
        ? "Turn it on from the dashboard's Get started or Settings → Accounts."
        : problem === PIM_COPY.automation_denied || problem === PIM_COPY.calendar_denied
          ? `Permission is off. Turn it on in System Settings › Privacy & Security › ${what === "mail" ? "Automation (Mail)" : "Calendars"}, then sync again.`
          : problem ?? (on ? (helper ? "Reading." : "Turned on, but the helper isn't installed.") : "Off. Optional."),
    };
  };
  return {
    spaceId: db ? inboxSpaceId(db) : null,
    clientId: db ? !!getSetting(db, CLIENT_ID_KEY) : false,
    sources: [
      {
        id: "google",
        label: "Google (Gmail and Calendar)",
        ready: google.length > 0 && signedOut.length === 0,
        message: !db
          ? "Connect from the dashboard's Get started or Settings → Accounts."
          : google.length === 0
            ? "Not connected. Optional."
            : signedOut.length
              ? `Signed out: ${signedOut.map((a) => a.address).join(", ")}. Connect again in Settings → Accounts.`
              : `${google.length} account${google.length === 1 ? "" : "s"} connected.`,
      },
      {
        id: "helper",
        label: "Mail and Calendar helper",
        ready: helper,
        message: helper ? "Installed with the Mac app." : "Not installed. It's only needed for Apple Mail and Calendar: run atrium app install.",
      },
      apple("mail", "Apple Mail"),
      apple("calendar", "Apple Calendar"),
    ],
  };
}
