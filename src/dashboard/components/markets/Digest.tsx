import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { useDigests } from "../../investing";
import type { Writeup } from "../../../engine/markets/research";
import { Markdown } from "../Markdown";
import { AdviceTag } from "./AdviceTag";

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const dateText = (iso: string) => dayFmt.format(Date.parse(`${iso}T12:00:00Z`));

// Claude's after-close digest at the top of the Overview, collapsed to a few lines.
export function Digest({ spaceId }: { spaceId: string }) {
  const digests = useDigests(spaceId);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  if (!digests?.length) return null;
  return <DigestList digests={digests} open={open} all={all} onOpen={() => setOpen(!open)} onAll={() => setAll(!all)} />;
}

export function DigestList({ digests, open, all, onOpen, onAll }: { digests: Writeup[]; open: boolean; all: boolean; onOpen: () => void; onAll?: () => void }) {
  const shown = all ? digests : digests.slice(0, 1);
  return (
    <section>
      <h2>
        {all ? "Last 7 digests" : "Latest digest"}
        <span className="h2-acts">
          <AdviceTag />
          {digests.length > 1 && (
            <button className="btn" onClick={onAll}>
              {all ? "Latest only" : `Last ${digests.length}`}
            </button>
          )}
        </span>
      </h2>
      <div className="list">
        {shown.map((d, n) => (
          <div key={d.id} className="rs-writeup digest">
            <div className="rs-writeup-head">
              <b>{dateText(d.forDate)}</b>
              <span className="faint">Claude, from that day's prices and headlines</span>
            </div>
            <Markdown className={open || all || n > 0 ? undefined : "clamp"} text={d.body} />
            {!all && (
              <button className="btn link" onClick={onOpen}>
                {open ? <ChevronUp /> : <ChevronDown />}
                {open ? "Less" : "More"}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
