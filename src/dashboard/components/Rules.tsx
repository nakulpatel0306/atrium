import { ChevronRight, Lock } from "lucide-react";
import { useState } from "react";
import { plural } from "../../engine/text";
import { activateOnKey } from "../activate";
import { post, type RuleDetail, type State, useRule } from "../api";
import { absolute, relative } from "../format";
import { navigate } from "../route";

type Rule = State["rules"][number];
type Proposal = State["proposals"][number];
type Space = State["spaces"][number];
type Approval = RuleDetail["approvals"][number];
type Event = RuleDetail["events"][number];

const ALWAYS_ASK = "Merging to main or deploying · Sending any message or text · Deleting anything · Anything that costs money · Touching secrets, .env files or keys · Creating GitHub repos, pushing, or removing local repo copies";

const EVENT_TEXT: Record<Event["event"], string> = {
  proposed: "Suggested",
  yes: "Said yes",
  not_now: "Not now",
  never: "Never suggest",
  suggest_again: "Suggest again",
  created: "Rule started",
  applied: "Approved automatically",
  undone: "Undid an approval",
  revoked: "Turned off",
  renewed: "Renewed",
  skipped_cap: "Hit the daily limit",
};

const DAY_MS = 86_400_000;

function endsIn(rule: Rule, now = Date.now()): string {
  const days = Math.ceil((rule.expiresAt - now) / DAY_MS);
  return days <= 1 ? "ends within a day" : `ends in ${plural(days, "day")}`;
}

function ended(rule: Rule): string {
  if (rule.state === "expired") return `Expired ${absolute(rule.expiresAt)}`;
  const when = absolute(rule.revokedAt ?? rule.expiresAt);
  return rule.revokedReason === "undone" ? `Ended (undone) ${when}` : `Turned off ${when}`;
}

function TaskLink({ approval, space }: { approval: Approval; space: Space | undefined }) {
  if (!approval.taskId || !space) return <span className="task-link">{approval.title}</span>;
  const href = `/space/${space.id}?task=${approval.taskId}`;
  return (
    <a
      href={href}
      className="task-link"
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {approval.title}
    </a>
  );
}

// Inline rather than a modal: the question sits right where the click was.
function Undo({ approval }: { approval: Approval }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (approval.undoneAt !== null) return <span className="faint">undone</span>;
  const undo = async () => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/approvals/${approval.id}/undo`);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else setConfirming(false);
  };
  return (
    <span className="undo">
      {error && <span className="err">{error}</span>}
      {confirming ? (
        <>
          <span>Reopen for review?</span>
          <button className="btn p" disabled={busy} onClick={() => void undo()}>
            Yes
          </button>
          <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button className="btn" onClick={() => setConfirming(true)}>
          Undo
        </button>
      )}
    </span>
  );
}

function RuleHistory({ rule, space }: { rule: Rule; space: Space | undefined }) {
  const detail = useRule(rule.id);
  if (!detail) return <p className="runs-empty">Loading…</p>;
  const titles = new Map(detail.approvals.map((a) => [a.id, a.title]));
  return (
    <>
      <p className="role">Covers {rule.label}.</p>
      <div className="meta">
        <span title={absolute(rule.createdAt)}>Started {relative(rule.createdAt)}</span>
        {rule.state === "active" && <span title={absolute(rule.expiresAt)}>Ends {absolute(rule.expiresAt)}</span>}
      </div>
      {detail.proposal && (
        <>
          <h3>Why it exists</h3>
          <ul className="runs evidence">
            {detail.proposal.evidence.map((e) => (
              <li key={e.id}>
                <span className="task-link">{e.title}</span>
                <span title={absolute(e.resolvedAt)}>you approved {relative(e.resolvedAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Automatic approvals</h3>
      {detail.approvals.length === 0 ? (
        <p className="runs-empty">This rule hasn't approved anything yet.</p>
      ) : (
        <ul className="runs auto-approvals">
          {detail.approvals.map((a) => (
            <li key={a.id}>
              <TaskLink approval={a} space={space} />
              <span title={a.resolvedAt ? absolute(a.resolvedAt) : undefined}>{a.resolvedAt ? relative(a.resolvedAt) : ""}</span>
              <Undo approval={a} />
            </li>
          ))}
        </ul>
      )}
      <h3>History</h3>
      <ul className="runs rule-events">
        {detail.events.map((e) => (
          <li key={e.id}>
            <span className="task-link">
              {EVENT_TEXT[e.event]}
              {e.approvalId && titles.has(e.approvalId) ? `: ${titles.get(e.approvalId)}` : ""}
            </span>
            <span>{e.actor === "you" ? "You" : "Atrium"}</span>
            <span title={absolute(e.createdAt)}>{relative(e.createdAt)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function RuleRow({ rule, space }: { rule: Rule; space: Space | undefined }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "renew" | "revoke") => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/rules/${rule.id}/${action}`);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  const active = rule.state === "active";
  return (
    <div className="entry">
      <div className="item rule" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => activateOnKey(e, () => setOpen(!open))}>
        <ChevronRight className={`chev${open ? " open" : ""}`} />
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? "Archived space"}</span>
        <span className="t" title={rule.label}>
          {rule.label}
          <span>
            {active
              ? `used ${plural(rule.appliedCount, "time")} · ${endsIn(rule)}`
              : `${ended(rule)} · used ${plural(rule.appliedCount, "time")}`}
          </span>
        </span>
        {active && (
          <div className="acts" onClick={(e) => e.stopPropagation()}>
            <button className="btn" disabled={busy} onClick={() => void act("renew")}>
              Renew
            </button>
            <button className="btn" disabled={busy} onClick={() => void act("revoke")}>
              Turn off
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="detail">
          <RuleHistory rule={rule} space={space} />
        </div>
      )}
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

function NeverRow({ proposal, space }: { proposal: Proposal; space: Space | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const again = async () => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/proposals/${proposal.id}/suggest-again`);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  return (
    <div className="entry">
      <div className="item">
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? "Archived space"}</span>
        <span className="t">
          {proposal.label}
          {proposal.answeredAt && <span title={absolute(proposal.answeredAt)}>you said never {relative(proposal.answeredAt)}</span>}
        </span>
        <div className="acts">
          <button className="btn" disabled={busy} onClick={() => void again()}>
            Suggest again
          </button>
        </div>
      </div>
      {error && <div className="row-err err">{error}</div>}
    </div>
  );
}

export function Rules({ state }: { state: State }) {
  const spaces = new Map(state.spaces.map((s) => [s.id, s]));
  const active = state.rules.filter((r) => r.state === "active");
  const done = state.rules.filter((r) => r.state !== "active");
  const empty = state.rules.length === 0 && state.neverAsk.length === 0;
  return (
    <div className="wrap">
      <h1>Rules</h1>
      <p className="brief">
        Rules let Atrium approve results you've told it to stop asking about. These always need your yes, whatever the rules
        say:
      </p>
      <p className="always">
        <Lock />
        {ALWAYS_ASK}
      </p>
      <p className="note-line rules-note">
        Rules can't see instructions written in plain prose, so keep agent instructions out of docs you let rules approve.
      </p>
      {empty ? (
        <div className="list">
          <div className="empty-row">
            No rules yet. When you approve the same kind of result five times without changes, Atrium will ask whether to stop
            asking.
          </div>
        </div>
      ) : (
        <>
          <h2>Active</h2>
          <div className="list">
            {active.length === 0 ? (
              <div className="empty-row">No active rules. Everything waits for you.</div>
            ) : (
              active.map((r) => <RuleRow key={r.id} rule={r} space={spaces.get(r.spaceId)} />)
            )}
          </div>
          {done.length > 0 && (
            <>
              <h2>Ended</h2>
              <div className="list">
                {done.map((r) => (
                  <RuleRow key={r.id} rule={r} space={spaces.get(r.spaceId)} />
                ))}
              </div>
            </>
          )}
          {state.neverAsk.length > 0 && (
            <>
              <h2>Not suggested</h2>
              <div className="list">
                {state.neverAsk.map((p) => (
                  <NeverRow key={p.id} proposal={p} space={spaces.get(p.spaceId)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
