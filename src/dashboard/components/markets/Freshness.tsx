import type { Quote } from "../../../engine/markets/providers/types";
import { freshnessLabel } from "../../markets";

// Every price carries where it came from and how old it is; a missing one says why.
export function Freshness({ quote, missing }: { quote: Quote | null; missing: string | null }) {
  const { text, tone } = freshnessLabel(quote, missing);
  return (
    <span className={`fresh ${tone}`} title={text}>
      {text}
    </span>
  );
}
