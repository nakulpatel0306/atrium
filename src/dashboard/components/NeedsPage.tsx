import { CheckCheck, ChevronLeft, Keyboard, PartyPopper } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { post, type State } from "../api";
import { absolute } from "../format";
import { askLine } from "../../engine/needs";
import { announce } from "../live";
import { showToast, undoLatest } from "../toast";
import { ACT, KEY_HELP, moveFocus, needsKey } from "../needs-keys";
import { attentionQueue, cleanReviews, isRisky, itemLine, itemTitle, KIND_TEXT, type QueueItem, waited } from "../queue";
import { KIND } from "../../engine/words";
import { navigate } from "../route";
import { ARM_MS, DecisionBar, OpenPoints, reopen } from "./Decision";
import { ChangesView } from "./ChangesView";
import { agentText } from "../agents";
import { LoopPanel } from "./LoopPanel";
import { Markdown } from "./Markdown";
import { MemoryProposal } from "./Memory";
import { OutcomeBanner } from "./OutcomeBanner";
import { ProjectDraftRow } from "./ProjectDraft";
import { ProposalRow } from "./Proposal";
import { RemovalRow } from "./RepoRemoval";
import { RetroCard } from "./Retro";
import { StopTask } from "./StopTask";
import { WalkthroughCard } from "./Walkthrough";
import { WhatItMade } from "./WhatItMade";

type Space = State["spaces"][number];
type Task = State["tasks"][number];
type Approval = State["approvals"][number];

// Rows are one line each, so a long queue only draws what's in view (and a screenful either side).
export const ROW_PX = 52;
const OVERSCAN = 12;
export function visibleRange(scrollTop: number, height: number, count: number): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / ROW_PX) - OVERSCAN);
  // Before the list has a height (first paint, a test), draw enough to fill a tall window.
  const shown = Math.ceil((height || 1200) / ROW_PX) + OVERSCAN * 2;
  return [first, Math.min(count, first + shown)];
}

function QueueRow({ item, state, selected, onSelect }: { item: QueueItem; state: State; selected: boolean; onSelect: () => void }) {
  const space = item.spaceId ? state.spaces.find((s) => s.id === item.spaceId) : undefined;
  const title = itemTitle(state, item);
  const line = itemLine(state, item);
  return (
    <li
      role="option"
      id={`q-${item.key}`}
      aria-selected={selected}
      className={`q-row${selected ? " on" : ""}${item.low ? " low" : ""}`}
      onClick={onSelect}
      title={`${title}\n${line}`}
    >
      <span className="q-title">{title}</span>
      <span className="q-line">
        <span className={`q-kind k-${item.kind}${riskyItem(state, item) ? " risky" : ""}`}>{KIND_TEXT[item.kind]}</span> {line}
      </span>
      <span className="q-meta">
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="q-space">{space?.name ?? "Atrium"}</span>
        <time dateTime={new Date(item.since).toISOString()} title={`Waiting since ${absolute(item.since)}`}>
          {waited(item.since)}
        </time>
      </span>
    </li>
  );
}

// The list, drawn only around what's in view. It's one listbox: the queue's keys move the selection, and the
// selected item opens beside it.
export function QueueList({ items, state, selected, onSelect }: { items: QueueItem[]; state: State; selected: string | null; onSelect: (key: string) => void }) {
  const box = useRef<HTMLUListElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);
  // Keeps the selected row in view as j and k move past the window.
  useEffect(() => {
    const el = box.current;
    const at = items.findIndex((i) => i.key === selected);
    if (!el || at < 0) return;
    const top = at * ROW_PX;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_PX > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_PX - el.clientHeight;
  }, [selected, items]);
  const [first, last] = visibleRange(view.top, view.height, items.length);
  return (
    <ul className="q-list" ref={box} role="listbox" aria-label="Waiting for you, longest first" aria-activedescendant={selected ? `q-${selected}` : undefined} tabIndex={0}>
      <li aria-hidden="true" style={{ height: first * ROW_PX }} className="q-pad" />
      {items.slice(first, last).map((i) => (
        <QueueRow key={i.key} item={i} state={state} selected={i.key === selected} onSelect={() => onSelect(i.key)} />
      ))}
      <li aria-hidden="true" style={{ height: (items.length - last) * ROW_PX }} className="q-pad" />
    </ul>
  );
}

// A result in the queue that isn't clean: its kind label takes the warning tone its Approve anyway has.
function riskyItem(state: State, item: QueueItem): boolean {
  const a = item.kind === "review" ? state.approvals.find((x) => x.id === item.key) : undefined;
  return !!a && isRisky(state, a);
}

// A yes held before it starts: what happens when, and the one step left, taking it back.
function Starting({ id, line }: { id: string; line: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = async () => {
    setBusy(true);
    const res = await reopen(id);
    setBusy(false);
    if (res.ok) showToast("Taken back. It's waiting for your answer again.");
    else setError(res.error ?? "Atrium couldn't take that back.");
  };
  return (
    <>
      <p className="dp-lead" role="note">
        {line}
      </p>
      <div className="acts">
        <button className="btn p" disabled={busy} onClick={() => void undo()}>
          {KIND.starting.action}
        </button>
      </div>
      {error && <p className="err">{error}</p>}
    </>
  );
}

// A result or question decided right here, with everything it rests on in view, the diff included: a decision never
// has to leave the queue.
function ApprovalDecision({ approval, task, space, state, armed }: { approval: Approval; task: Task | undefined; space: Space | undefined; state: State; armed: boolean }) {
  const outcome = task?.outcome && task.outcome !== "done" ? task.outcome : null;
  const repo = space?.kind === "repo";
  const diff = repo && task?.branch && approval.kind === "review" && !task.loop?.noChanges;
  return (
    <>
      <div className="dp-acts">
        <DecisionBar approval={approval} state={state} armed={armed} keys />
      </div>
      {/* Why a risky result asks for a look, before anything else on its screen. */}
      {task && isRisky(state, approval) && <OpenPoints task={task} />}
      {task?.loop?.noChanges ? (
        // Said plainly: an empty result has no commits to read or push, whatever the agent's own words were.
        <p className="dp-lead" role="note">
          It made no changes: its branch holds nothing new.
        </p>
      ) : (
        outcome && <OutcomeBanner outcome={outcome} reason={task?.outcomeReason ?? null} />
      )}
      {task && space ? (
        <>
          {/* What changed and where to look first leads; the diff itself next; the brief, checks and findings after. */}
          <WalkthroughCard task={task} space={space} />
          {diff && <ChangesView task={task} agent={agentText(task, state.runs)} />}
          {task.loop && <LoopPanel task={task} state={state} repo={repo} showChecks={task.loop.checks === "failed"} briefOpen={!diff} reasonsAbove={isRisky(state, approval)} />}
          <RetroCard task={task} state={state} />
          {!diff && <WhatItMade taskId={task.id} spaceId={space.id} spaceKind={space.kind} noChanges={task.loop?.noChanges} />}
        </>
      ) : (
        <Markdown text={approval.detail || "No further detail."} />
      )}
    </>
  );
}

// One screen per item: what it is, how long it has waited, and everything needed to decide, with the decision's own
// buttons. The queue's keys press those buttons, so a key can never do what a click wouldn't.
export function DecisionPanel({ item, state, armed = false }: { item: QueueItem; state: State; armed?: boolean }) {
  const space = item.spaceId ? state.spaces.find((s) => s.id === item.spaceId) : undefined;
  const task = item.taskId ? state.tasks.find((t) => t.id === item.taskId) : undefined;
  const approval = item.kind === "review" || item.kind === "approval" ? state.approvals.find((a) => a.id === item.key) : undefined;
  const action = approval ? state.repoActions.find((r) => r.approvalId === approval.id) : undefined;
  const memory = item.kind === "memory" ? state.learning.memory.find((m) => m.id === item.key) : undefined;
  const proposal = item.kind === "suggestion" ? state.proposals.find((p) => p.id === item.key) : undefined;

  let body;
  if (approval?.alwaysAsk === "create_repo" && action?.draft) body = <div className="list needs-list"><ProjectDraftRow approval={approval} action={action} /></div>;
  else if (approval?.alwaysAsk === "remove_clone") body = <div className="list needs-list"><RemovalRow approval={approval} /></div>;
  else if (approval) body = <ApprovalDecision approval={approval} task={task} space={space} state={state} armed={armed} />;
  else if (proposal) body = <div className="list needs-list"><ProposalRow proposal={proposal} space={space} /></div>;
  else if (memory && space) body = <MemoryProposal line={memory} space={space} />;
  else if (item.kind === "starting") body = <Starting id={item.key} line={itemLine(state, item)} />;
  else if (task)
    body = (
      <>
        {/* Why it waits, first: the pause's own diagnosis, or what the split or attempts need. A question needs no lead:
            its answer form below says it. */}
        {item.kind !== "question" && (
          <p className={`dp-lead${item.kind === "paused" ? " wait" : ""}`} role="note">
            {item.kind === "paused" ? `Paused: ${askLine(task)}` : askLine(task)}
          </p>
        )}
        {item.kind === "shape" && (
          <div className="dp-acts">
            <StopTask task={task} />
          </div>
        )}
        <LoopPanel task={task} state={state} repo={space?.kind === "repo"} showChecks={task.loop?.checks === "failed"} briefOpen />
      </>
    );

  return (
    <article className="dp" aria-labelledby="dp-title" tabIndex={-1}>
      <header className="dp-head">
        <span className={`q-kind k-${item.kind}${riskyItem(state, item) ? " risky" : ""}`}>{KIND_TEXT[item.kind]}</span>
        <h2 id="dp-title">{itemTitle(state, item)}</h2>
        <p className="dp-meta">
          <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
          {space?.name ?? "Atrium"}
          <span aria-hidden="true">·</span>
          {/* The same short form as the row beside it, with the exact time on hover. */}
          <span title={`Waiting since ${absolute(item.since)}`}>{waited(item.since) === "now" ? "just now" : `waiting ${waited(item.since)}`}</span>
          {item.low && (
            <>
              <span aria-hidden="true">·</span>
              <span>low priority: nothing waits on it</span>
            </>
          )}
          {task && space && (
            <a
              href={`/space/${space.id}?task=${task.id}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/space/${space.id}?task=${task.id}`);
              }}
            >
              Open the task
            </a>
          )}
        </p>
      </header>
      <div className="dp-body">{body ?? <p className="hint">This was answered somewhere else.</p>}</div>
    </article>
  );
}

// Approve every clean result in one go, after one look at what's included. Anything with a note, a check that
// didn't pass or an open finding is never offered here; the engine checks each one again.
function BatchApprove({ state, items, open, setOpen }: { state: State; items: QueueItem[]; open: boolean; setOpen: (v: boolean) => void }) {
  const clean = cleanReviews(state, items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<{ title: string; reason: string }[]>([]);
  if (clean.length < 2 && !left.length) return null;
  const approve = async () => {
    setBusy(true);
    setError(null);
    // Each one at the commit this list shows; the engine leaves any that moved since.
    const shown = clean.map((i) => ({ id: i.key, sha: state.tasks.find((t) => t.id === i.taskId)?.loop?.checkedSha ?? "", title: itemTitle(state, i) }));
    const res = await post<{ approved: string[]; skipped: { id: string; reason: string }[] }>("/api/approvals/batch", { items: shown.map(({ id, sha }) => ({ id, sha })) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const skipped = res.data.skipped.map((s) => ({ title: shown.find((x) => x.id === s.id)?.title ?? s.id, reason: s.reason }));
    // Said on screen, with one Undo that takes the whole batch back while it can.
    const approved = res.data.approved;
    if (approved.length) {
      showToast(`Approved ${approved.length}.${skipped.length ? ` ${skipped.length} left to read on their own.` : ""}`, async () => {
        const back = await Promise.all(approved.map(reopen));
        const failed = back.find((b) => !b.ok);
        return failed ?? { ok: true };
      });
    }
    setLeft(skipped);
    if (!skipped.length) setOpen(false);
  };
  return (
    <div className="batch">
      {clean.length >= 2 && (
        <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          <CheckCheck />
          Approve {clean.length} clean results
        </button>
      )}
      {(open || left.length > 0) && (
        <div className="batch-sheet" role="dialog" aria-label="Approve clean results">
          {left.length > 0 ? (
            <>
              <p>These were left for you to read on their own:</p>
              <ul>
                {left.map((l) => (
                  <li key={l.title}>
                    {l.title}: <span className="hint">{l.reason}</span>
                  </li>
                ))}
              </ul>
              <div className="acts">
                <button className="btn" onClick={() => setLeft([])}>
                  OK
                </button>
              </div>
            </>
          ) : (
            <>
              <p>Each of these passed its checks, was approved by its reviewer, and has no notes or open findings:</p>
              <ul>
                {clean.map((i) => (
                  <li key={i.key}>{itemTitle(state, i)}</li>
                ))}
              </ul>
              <div className="acts">
                <button className="btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button className="btn p" autoFocus disabled={busy} onClick={() => void approve()}>
                  Approve all {clean.length}
                </button>
              </div>
            </>
          )}
          {error && <p className="err">{error}</p>}
        </div>
      )}
    </div>
  );
}

function KeysSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="keys-sheet" role="dialog" aria-label="Keys">
      <h3>Keys</h3>
      <dl>
        {KEY_HELP.map(([k, what]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      {/* The same words every surface uses (engine/words.ts), said once in full. */}
      <h3>What each item asks</h3>
      <dl className="kinds">
        {Object.values(KIND).map((k) => (
          <div key={k.label}>
            <dt>{k.label}</dt>
            <dd>
              {k.means} <span className="hint">Next: {k.action}.</span>
            </dd>
          </div>
        ))}
      </dl>
      <button className="btn" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

// Everything waiting on the user as one queue, longest-blocked first, worked through from the keyboard: the list on
// the left, the selected item's whole decision on the right (or full width on a narrow window once opened).
export function NeedsPage({ state, item = null, batch: batchAsked = false }: { state: State; item?: string | null; batch?: boolean }) {
  const items = attentionQueue(state);
  const count = items.filter((i) => !i.low).length;
  const low = items.length - count;
  const [selected, setSelected] = useState<string | null>(item);
  const [opened, setOpened] = useState(item !== null);
  const [help, setHelp] = useState(false);
  const [batch, setBatch] = useState(batchAsked);
  // The item whose risky Approve the a key has been pressed once for; a second a approves it.
  const [armed, setArmed] = useState<string | null>(null);
  // The first a on a risky result disarms by itself, as a first click does.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const panel = useRef<HTMLDivElement>(null);
  // Where the selection was, so when the item there is answered and leaves, the next one takes its place.
  const at = useRef(0);
  const index = items.findIndex((i) => i.key === selected);
  if (index >= 0) at.current = index;
  const current = index >= 0 ? items[index]! : items[Math.min(at.current, items.length - 1)];

  useEffect(() => {
    if (item) setSelected(item);
  }, [item]);
  useEffect(() => {
    setArmed(null);
  }, [current?.key]);

  // Live values for the key handler, which is attached once.
  const live = useRef({ items, current, opened, armed, clean: 0 });
  live.current = { items, current, opened, armed, clean: cleanReviews(state, items).length };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = needsKey(e);
      if (!key) return;
      const { items, current, opened, armed } = live.current;
      const i = current ? items.indexOf(current) : -1;
      if (key === "help") return setHelp((h) => !h);
      if (key === "close") {
        setHelp(false);
        setBatch(false);
        if (opened) setOpened(false);
        return;
      }
      if (key === "next" || key === "prev") {
        e.preventDefault();
        const next = items[moveFocus(i, items.length, key)];
        if (next) setSelected(next.key);
        return;
      }
      if (key === "undo") return void undoLatest();
      if (key === "batch") {
        if (live.current.clean < 2) return announce("Shift A approves two or more clean results at once; fewer than two are clean right now.");
        return setBatch(true);
      }
      // Enter on a button or link is that control's own press.
      if (key === "open") {
        if (document.activeElement && document.activeElement !== document.body && !document.activeElement.closest(".q-list")) return;
        e.preventDefault();
        setOpened(true);
        requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(".dp")?.focus());
        return;
      }
      // On a narrow window the list hides the decision; a key must never press a button nobody can see.
      if (panel.current && getComputedStyle(panel.current).display === "none") return;
      const button = panel.current?.querySelector<HTMLButtonElement>(`[data-act="${ACT[key]}"]`);
      if (!button || button.disabled) return;
      // Keeps the letter out of the note field that s is about to focus.
      e.preventDefault();
      // A result with notes or open findings takes a second a: one key shouldn't approve what asks to be read.
      if (key === "approve" && button.dataset.risky && armed !== current?.key) {
        setArmed(current?.key ?? null);
        return announce("Press a again to approve anyway.");
      }
      setArmed(null);
      button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="wrap queue-page">
      <div className="page-head">
        <h1>Needs you{count > 0 && ` · ${count}`}</h1>
        {low > 0 && <span className="low-count">+ {low} low priority</span>}
        <BatchApprove state={state} items={items} open={batch} setOpen={setBatch} />
        <button className="btn link subtle keys-btn" aria-expanded={help} onClick={() => setHelp(!help)}>
          <Keyboard />
          Keys <kbd>?</kbd>
        </button>
      </div>
      {help && <KeysSheet onClose={() => setHelp(false)} />}
      {items.length === 0 ? (
        <div className="q-empty">
          <PartyPopper />
          <p>You're all caught up.</p>
          <p className="hint">Results land here once Atrium's checks and a reviewer have been at them.</p>
        </div>
      ) : (
        <div className={`queue${opened ? " opened" : ""}`}>
          <QueueList
            items={items}
            state={state}
            selected={current?.key ?? null}
            onSelect={(key) => {
              setSelected(key);
              setOpened(true);
            }}
          />
          <div className="q-panel" ref={panel}>
            <button className="btn link q-back" onClick={() => setOpened(false)}>
              <ChevronLeft />
              All items
            </button>
            {current && <DecisionPanel key={current.key} item={current} state={state} armed={armed === current.key} />}
          </div>
        </div>
      )}
    </div>
  );
}
