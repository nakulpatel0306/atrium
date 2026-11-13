import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Home } from "../../src/dashboard/components/Home";
import { OldDataList, OldDataNotice, removeOldDataNow } from "../../src/dashboard/components/OldData";
import { DataSection } from "../../src/dashboard/components/Settings";
import type { OldData } from "../../src/engine/old-data-view";
import { makeState } from "../tui/fixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const home = (oldData: { present: boolean; dismissed: boolean }) => {
  const state = { ...makeState(), oldData };
  return text(renderToStaticMarkup(<Home state={state} briefing={state.briefing} onNewSpace={() => {}} />));
};

const found: OldData = {
  groups: [{ label: "Mail and calendar", tables: [{ name: "mail_bodies", rows: 3 }, { name: "mail_accounts", rows: 1 }] }],
  settings: ["mail.syncedAt"],
  approvals: 0,
  keychain: ["google.refresh.acc_1"],
  spaces: ["Inbox"],
};

test("Home shows the old-data notice once, until it's removed or put off", () => {
  expect(home({ present: true, dismissed: false })).toContain("Remove old data");
  expect(home({ present: true, dismissed: false })).toContain("Not now");
  expect(home({ present: true, dismissed: true })).not.toContain("Remove old data");
  expect(home({ present: false, dismissed: false })).not.toContain("Remove old data");
});

test("Settings → Data offers it whenever there's old data, without Not now", () => {
  const shown = text(renderToStaticMarkup(<DataSection oldData={{ present: true, dismissed: true }} />));
  expect(shown).toContain("Remove old data");
  expect(shown).not.toContain("Not now");
  expect(renderToStaticMarkup(<DataSection oldData={{ present: false, dismissed: false }} />)).toBe("");
  expect(text(renderToStaticMarkup(<OldDataNotice dismissable />))).toContain("Not now");
});

test("the confirm lists exactly what goes, and what stays", () => {
  const shown = text(renderToStaticMarkup(<OldDataList data={found} />));
  expect(shown).toContain("Mail and calendar: 4 rows in mail_bodies (3), mail_accounts (1)");
  expect(shown).toContain("Settings: mail.syncedAt");
  expect(shown).toContain('Keychain items (service "Atrium"): google.refresh.acc_1');
  expect(shown).toContain("Inbox stays");
  expect(shown).toContain("Your projects, repos and other spaces aren't touched.");
});

test("removing posts once and says what went", async () => {
  const sent: string[] = [];
  const ok = async (path: string) => (sent.push(path), { ok: true as const, data: found });
  expect(await removeOldDataNow(ok)).toEqual({ toast: "Removed the old data: 4 rows and 1 Keychain item." });
  expect(sent).toEqual(["/api/old-data/remove"]);
  expect(await removeOldDataNow(async () => ({ ok: false as const, error: "Keychain is locked." }))).toEqual({ error: "Keychain is locked." });
  expect(await removeOldDataNow(async () => ({ ok: true as const, data: null }))).toEqual({ toast: "Nothing was left to remove." });
});
