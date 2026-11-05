import type { Sourced } from "../../../engine/markets/sourced";
import { sourceTone } from "../../investing";

// Where a number came from and how fresh it is; the full text is always one hover away.
export function SourceTag({ s, missing }: { s: Sourced<unknown> | null; missing?: string }) {
  if (!s) {
    const text = missing ?? "No data yet";
    return (
      <span className="fresh none" title={text}>
        {text}
      </span>
    );
  }
  return (
    <span className={`fresh ${sourceTone(s.tone)}`} title={s.source}>
      {s.source}
    </span>
  );
}
