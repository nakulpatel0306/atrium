import { sparkPath } from "../../simple";

const W = 60;
const H = 24;

export function Sparkline({ values, up }: { values: number[]; up: boolean | null }) {
  const d = sparkPath(values, W, H);
  return (
    <svg className={`spark ${up === null ? "flat" : up ? "up" : "down"}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      {d && <path d={d} />}
    </svg>
  );
}
