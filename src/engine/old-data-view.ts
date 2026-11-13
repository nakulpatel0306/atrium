// What features Atrium no longer has left behind on an older install: their tables, settings, approvals nobody can
// act on, and Keychain items. Nothing removes it until the user has seen this list and said yes. Kept free of engine
// imports so the dashboard and the CLI show the same list.
export type OldData = {
  groups: { label: string; tables: { name: string; rows: number }[] }[];
  settings: string[];
  approvals: number;
  keychain: string[];
  // Spaces of removed kinds. They stay (with their tasks) until the user deletes them, like any other space.
  spaces: string[];
};

const rows = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

// One line per kind of thing that goes, for the dashboard's confirm and the terminal.
export function oldDataLines(d: OldData): string[] {
  return [
    ...d.groups.map((g) => `${g.label}: ${rows(g.tables.reduce((n, t) => n + t.rows, 0))} in ${g.tables.map((t) => `${t.name} (${t.rows})`).join(", ")}`),
    ...(d.settings.length ? [`Settings: ${d.settings.join(", ")}`] : []),
    ...(d.approvals ? [`Approvals nobody can act on: ${d.approvals}`] : []),
    ...(d.keychain.length ? [`Keychain items (service "Atrium"): ${d.keychain.join(", ")}`] : []),
  ];
}
