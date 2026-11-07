import type { Group, SubFlag, SubscriptionList } from "../../../engine/money/subscriptions";
import { cadText } from "../../simple";
import { shortDate } from "./MoneyRecap";

const FLAG: Record<SubFlag, string> = { "price-up": "price went up", forgotten: "maybe forgotten", new: "new this month" };
const FLAG_HINT: Record<SubFlag, string> = {
  "price-up": "The last charge was higher than the ones before.",
  forgotten: "Under CA$50 a month for over 3 months, still charging, and nothing else from this merchant in 90 days.",
  new: "Its first charge is in the latest month.",
};

// "Presto Fare/toronto" → "Presto Fare/Toronto": display only, the stored merchant stays as imported.
const pretty = (merchant: string) => merchant.replace(/\/([a-z])/g, (_, c: string) => `/${c.toUpperCase()}`);

function Rows({ group }: { group: Group }) {
  return (
    <>
      <p className="money-subs-total">
        <b>{cadText(group.perMonth)}</b> a month · <b>{cadText(group.perYear)}</b> a year
      </p>
      <ul className="money-list money-subs">
        {group.list.map((s) => (
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

// Every charge that comes back on a schedule, with rent and bills apart. Facts only: Atrium can't cancel anything.
export function MoneySubs({ subs }: { subs: SubscriptionList }) {
  if (!subs.list.length && !subs.bills.list.length) return <p className="faint">No recurring charges found yet. They show up after two or three months of imports.</p>;
  return (
    <>
      {subs.list.length > 0 ? <Rows group={subs} /> : <p className="faint">No subscriptions found yet.</p>}
      {subs.bills.list.length > 0 && (
        <>
          <h4 className="money-subhead">Bills</h4>
          <Rows group={subs.bills} />
        </>
      )}
    </>
  );
}
