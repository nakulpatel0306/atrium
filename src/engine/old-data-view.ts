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

// What the removal never touches.
export function oldDataStays(d: OldData): string[] {
  const one = d.spaces.length === 1;
  const spaces = d.spaces.length
    ? [`${d.spaces.join(", ")} ${one ? "stays" : "stay"}, with ${one ? "its" : "their"} tasks. Delete ${one ? "it" : "them"} yourself if you don't need ${one ? "it" : "them"}.`]
    : [];
  return [...spaces, "Your projects, repos and other spaces aren't touched."];
}

export function removedLine(d: OldData | null): string {
  if (!d) return "Nothing was left to remove.";
  const n = d.groups.reduce((sum, g) => sum + g.tables.reduce((m, t) => m + t.rows, 0), 0);
  return `Removed the old data: ${n} ${n === 1 ? "row" : "rows"} and ${d.keychain.length} ${d.keychain.length === 1 ? "Keychain item" : "Keychain items"}.`;
}
