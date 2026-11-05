// Pure: shared by the engine and the dashboard, so it imports types only.
import type { Stage } from "./ideas";
import type { Sourced } from "./sourced";

export type ScreenRow = {
  key: string;
  name: string;
  price: Sourced | null;
  pe: Sourced | null;
  pos52: number | null;
  fromHighPct: number | null;
  rsi14: number | null;
  divYield: Sourced | null;
  held: boolean;
  stage: Stage;
  // Where the 52-week high and low came from.
  range52Source: string | null;
};
export type ScreenFilter = { field: "pe" | "pos52" | "fromHighPct" | "rsi14" | "divYield"; min?: number; max?: number };


// Pure, so the dashboard filters the same way. A row without the field fails a filter on it.
export function applyFilters(rows: ScreenRow[], filters: ScreenFilter[]): ScreenRow[] {
  const value = (r: ScreenRow, f: ScreenFilter["field"]): number | null => {
    const v = r[f];
    return v === null ? null : typeof v === "number" ? v : v.value;
  };
  return rows.filter((r) =>
    filters.every((f) => {
      const v = value(r, f.field);
      if (f.min === undefined && f.max === undefined) return true;
      return v !== null && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
    }),
  );
}
