import type { SubFlag, SubscriptionList } from "../../../engine/money/subscriptions";
import { cadText } from "../../simple";
import { shortDate } from "./MoneyRecap";

const FLAG: Record<SubFlag, string> = { "price-up": "price went up", forgotten: "maybe forgotten", new: "new this month" };
const FLAG_HINT: Record<SubFlag, string> = {
  "price-up": "The last charge was higher than the ones before.",
  forgotten: "Nothing else from this merchant in 90 days, and it's still charging.",
  new: "Its first charge is in the latest month.",
};

// "Presto Fare/toronto" → "Presto Fare/Toronto": display only, the stored merchant stays as imported.
const pretty = (merchant: string) => merchant.replace(/\/([a-z])/g, (_, c: string) => `/${c.toUpperCase()}`);

// Every charge that comes back on a schedule. Facts only: Atrium can't cancel anything.
export function MoneySubs({ subs }: { subs: SubscriptionList }) {
  if (!subs.list.length) return <p className="faint">No recurring charges found yet. They show up after two or three months of imports.</p>;
  return (
    <>
      <p className="money-subs-total">
        <b>{cadText(subs.perMonth)}</b> a month · <b>{cadText(subs.perYear)}</b> a year
      </p>
      <ul className="money-list money-subs">
        {subs.list.map((s) => (
          <li key={s.merchant}>
            <b>{pretty(s.merchant)}</b>
            <span>
              {cadText(s.amount)} {s.cadence === "monthly" ? "a month" : "a year"}
            </span>
            <span className="faint">
              Last {shortDate(s.last)} · next around {shortDate(s.next)}
              {s.was !== null && ` · was ${cadText(s.was)}`}
              {s.flags.map((f) => (
                <span key={f} className={`money-flag flag-${f}`} title={FLAG_HINT[f]}>
                  {FLAG[f]}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
