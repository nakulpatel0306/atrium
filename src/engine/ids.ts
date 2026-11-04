export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}
