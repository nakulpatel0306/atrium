import type { PerfResult } from "../engine/markets/performance";
import type { Tone } from "../engine/markets/sourced";
import type { BudgetView, HealthView, ResearchView, TfsaView } from "../server/investing";
import type { Idea } from "../engine/markets/ideas";
import type { Writeup } from "../engine/markets/research";
import type { ScreenRow } from "../engine/markets/screen";
import { useEngineState, useFetched } from "./api";

export type { BudgetView, HealthView, ResearchView, TfsaView };

// Investing views, read again on every engine change. Every one of these routes reads the engine's DB only.
const space = (id: string) => `/api/investing/${encodeURIComponent(id)}`;
export const useHealth = (spaceId: string) => useFetched<HealthView>(`${space(spaceId)}/health`, useEngineState());
export const useBudget = () => useFetched<BudgetView>("/api/investing/budget", useEngineState());
export const useTfsa = (year: number) => useFetched<TfsaView>(`/api/investing/tfsa?year=${year}`, useEngineState());
export const useResearch = (spaceId: string, key: string | null) =>
  useFetched<ResearchView>(key ? `${space(spaceId)}/research/${encodeURIComponent(key)}` : null, useEngineState());
export const useIdeas = (spaceId: string) => useFetched<Idea[]>(`${space(spaceId)}/ideas`, useEngineState());
export const useScreener = (spaceId: string) => useFetched<ScreenRow[]>(`${space(spaceId)}/screener`, useEngineState());
export const useDigests = (spaceId: string) => useFetched<Writeup[]>(`${space(spaceId)}/digests`, useEngineState());
export const investingPath = space;

export type BadgeTone = "live" | "delayed" | "estimate" | "demo" | "none";
// Official (Bank of Canada, issuer files) and entered numbers are as good as live for their purpose.
export function sourceTone(t: Tone): BadgeTone {
  if (t === "official" || t === "entered") return "live";
  return t;
}

const one = (n: number) => (Math.round(Math.abs(n) * 10) / 10).toFixed(1);
export const pctText = (n: number | null): string => (n === null ? "n/a" : `${n < 0 ? "−" : ""}${one(n)}%`);
export const signedPctText = (n: number | null): string => (n === null ? "n/a" : `${n < 0 ? "−" : "+"}${one(n)}%`);

export function perfRow(r: PerfResult): { label: string; you: string; spy: string; xeqt: string; title: string } {
  const b = (key: string) => r.benchmarks.find((x) => x.key === key);
  const why = [
    ...r.missing.map((m) => `${m.key}: ${m.reason}`),
    ...r.benchmarks.filter((x) => x.reason).map((x) => `${x.key}: ${x.reason}`),
    `${r.start} to ${r.end}, ${r.basis}.`,
    r.note,
  ];
  return { label: r.period, you: signedPctText(r.portfolioPct), spy: signedPctText(b("SPY")?.pct ?? null), xeqt: signedPctText(b("XEQT.TO")?.pct ?? null), title: why.join("\n") };
}

// Nulls sort last whichever way the column is sorted; sourced cells sort by their value.
export function sortRows<T>(rows: T[], by: keyof T, dir: "asc" | "desc"): T[] {
  const val = (r: T): number | string | null => {
    const v = r[by] as unknown;
    if (v === null || v === undefined) return null;
    if (typeof v === "object" && "value" in v) return (v as { value: number }).value;
    return v as number | string;
  };
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return dir === "asc" ? c : -c;
  });
}

const sessionFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const etDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
// "today" while the change is today's session, else the session it's from.
export const dayText = (dayOf: string | null, now: number): string =>
  !dayOf || dayOf === etDayFmt.format(now) ? "today" : `on ${sessionFmt.format(Date.parse(`${dayOf}T12:00:00Z`))}`;
