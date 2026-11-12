import { useCallback, useEffect, useState } from "react";
import type { Check, Report } from "../../engine/doctor";
import { claudeBlocks, nextStep, prevStep, STEPS, type Progress, type Step } from "../../engine/start-steps";
import { post, put } from "../api";
import { navigate } from "../route";
import { type MailOverview, useMailOverview } from "../mail";
import { AppleSource, GoogleConnect } from "./MailSources";

export const STEP_TITLES: Record<Step, string> = {
  welcome: "Welcome",
  agents: "Agents",
  tools: "Optional tools",
  investing: "Investing and money",
  mail: "Mail and calendar",
  profile: "Your name and projects folder",
  done: "Done",
};

// The steps the user may leave out. Agents can't be left out while Claude is missing.
export const canSkip = (step: Step): boolean => step !== "welcome" && step !== "agents" && step !== "done";

function CheckRow({ check }: { check: Check }) {
  return (
    <div className={`set-card start-check ${check.state}`}>
      <div className="set-title">
        <b>{check.label}</b>
        <span className="tag">{check.required ? "Required" : "Optional"}</span>
        <span className={`tag${check.state === "ready" ? " ok" : ""}`}>{check.state === "ready" ? `Ready${check.version ? ` · ${check.version}` : ""}` : check.state === "not_installed" ? "Not installed" : check.state === "too_old" ? "Too old" : check.state === "signed_out" ? "Signed out" : "Unconfirmed"}</span>
      </div>
      <p className="hint">{check.message}</p>
      {check.state === "not_installed" && (
        <p className="hint">
          Install: <code>{check.install}</code>
        </p>
      )}
      {check.state !== "ready" && check.state !== "too_old" && (
        <p className="hint">
          Sign in: <code>{check.signIn}</code>
        </p>
      )}
    </div>
  );
}

export type ProfileDraft = { name: string; projectsRoot: string };

type ViewProps = {
  report: Report;
  // Mail sources, read separately so a sign-in finishing in the browser shows up here.
  mail?: MailOverview | null;
  progress: Progress;
  draft: ProfileDraft;
  message: string | null;
  busy?: boolean;
  onDraft(d: ProfileDraft): void;
  onGo(step: Step): void;
  onSkip(step: Step): void;
  onRecheck(): void;
  onSetupInvesting(): void;
  onSaveProfile(): void;
  onFinish(): void;
  onDismiss(): void;
};

// One step at a time. Everything it shows comes from the same checks as `atrium doctor`.
export function StartView(p: ViewProps) {
  const { report, progress } = p;
  const step = progress.step;
  const index = STEPS.indexOf(step);
  const blocked = claudeBlocks(report);
  const next = nextStep(step);
  return (
    <div className="wrap start">
      <h1>Get started</h1>
      <p className="brief">
        Step {index + 1} of {STEPS.length} · {STEP_TITLES[step]}
      </p>
      {p.message && <p className="hint start-message">{p.message}</p>}

      {step === "welcome" && (
        <>
          <p>Atrium is a command center on your Mac for the AI agents you already use. You describe the work, agents do it in the background, and anything that leaves your Mac waits for your yes.</p>
          <p className="hint">Next: check your agents, pick optional tools, connect mail and calendar if you like, then choose your name and projects folder. Everything except Claude can be skipped, and you can come back to this from Settings.</p>
        </>
      )}

      {step === "agents" && (
        <>
          {report.agents.map((a) => (
            <CheckRow key={a.id} check={a} />
          ))}
          <button className="btn" onClick={p.onRecheck} disabled={p.busy}>
            Check again
          </button>
          {blocked && <p className="hint">Claude is required before you can finish. {blocked}</p>}
        </>
      )}

      {step === "tools" && (
        <>
          <CheckRow check={report.github} />
          <button className="btn" onClick={p.onRecheck} disabled={p.busy}>
            Check again
          </button>
          {report.permissions.map((perm) => (
            <div key={perm.label} className="set-card">
              <div className="set-title">
                <b>{perm.label}</b>
                <span className="tag">Optional</span>
              </div>
              <p className="hint">{perm.message} Atrium doesn't ask from this screen.</p>
            </div>
          ))}
        </>
      )}

      {step === "investing" && (
        <>
          <div className="set-card">
            <div className="set-title">
              <b>Investing</b>
              <span className="tag">Optional</span>
              {report.investing.spaceId && <span className="tag ok">Set up</span>}
            </div>
            <p className="hint">Creates an empty, private Investing space. Import your holdings there or add tickers yourself. Add free market-data keys (Finnhub, Alpha Vantage) in Settings; they stay in your Mac's Keychain.</p>
            {!report.investing.spaceId && (
              <button className="btn" onClick={p.onSetupInvesting} disabled={p.busy}>
                Set up investing
              </button>
            )}
          </div>
          <div className="set-card">
            <div className="set-title">
              <b>Money</b>
              <span className="tag">Optional</span>
            </div>
            <p className="hint">{report.money.message} Recognised formats: {report.money.formats.join("; ")}. Money lives in the Investing space, so set that up first.</p>
          </div>
        </>
      )}

      {step === "mail" && (
        <>
          <p>Atrium can read your mail and calendar on this Mac, so you can ask things like "when am I free Thursday?" from one place. Each source is optional and only goes to Claude.</p>
          {p.mail ? (
            <>
              <GoogleConnect overview={p.mail} />
              <AppleSource what="mail" overview={p.mail} />
              <AppleSource what="calendar" overview={p.mail} />
            </>
          ) : (
            <p className="hint">Checking your accounts…</p>
          )}
        </>
      )}

      {step === "profile" && (
        <form
          className="mk-form"
          onSubmit={(e) => {
            e.preventDefault();
            p.onSaveProfile();
          }}
        >
          <label>
            Your name
            <input value={p.draft.name} placeholder={report.profile.suggestedName ?? "Optional"} onChange={(e) => p.onDraft({ ...p.draft, name: e.target.value })} />
          </label>
          <label>
            Projects folder
            <input value={p.draft.projectsRoot} onChange={(e) => p.onDraft({ ...p.draft, projectsRoot: e.target.value })} />
          </label>
          <p className="hint">New projects and clones go in the projects folder. Amounts are in {report.profile.homeCurrency} for now.</p>
          <button className="btn" type="submit" disabled={p.busy}>
            Save
          </button>
        </form>
      )}

      {step === "done" && (
        <>
          <ul className="start-summary">
            {report.agents.map((a) => (
              <li key={a.id}>
                {a.label}: {a.state === "ready" ? "ready" : a.required ? "needs attention" : "skipped or not ready"}
              </li>
            ))}
            <li>GitHub CLI: {report.github.state === "ready" ? "ready" : "not set up"}</li>
            <li>Investing: {report.investing.spaceId ? "set up" : "skipped"}</li>
            <li>Mail and calendar: {report.mail.sources.some((m) => m.id !== "helper" && m.ready) ? "connected" : "skipped"}</li>
            <li>Projects folder: {report.profile.projectsRoot}</li>
          </ul>
          {progress.skipped.length > 0 && <p className="hint">Skipped: {progress.skipped.map((s) => STEP_TITLES[s]).join(", ")}. Find them again in Settings → Get started.</p>}
          {blocked && <p className="hint">Claude is required before you can finish. {blocked}</p>}
        </>
      )}

      <div className="start-nav">
        {index > 0 && step !== "done" && (
          <button className="btn" onClick={() => p.onGo(prevStep(step))}>
            Back
          </button>
        )}
        {step === "done" && (
          <button className="btn" onClick={() => p.onGo("profile")}>
            Back
          </button>
        )}
        {step !== "done" && (
          <button className="btn link" onClick={p.onDismiss}>
            Skip for now
          </button>
        )}
        {canSkip(step) && (
          <button className="btn link" onClick={() => p.onSkip(step)}>
            Skip
          </button>
        )}
        {step !== "done" && (
          <button className="btn primary" onClick={() => p.onGo(next)} disabled={next === "done" && blocked !== null}>
            Next
          </button>
        )}
        {step === "done" && (
          <button className="btn primary" onClick={p.onFinish} disabled={blocked !== null}>
            Open home
          </button>
        )}
      </div>
    </div>
  );
}

export function GetStarted() {
  const [data, setData] = useState<{ report: Report; progress: Progress } | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>({ name: "", projectsRoot: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mail = useMailOverview();

  const load = useCallback(async () => {
    setBusy(true);
    const res = await fetch("/api/start").then((r) => r.json() as Promise<{ report: Report; progress: Progress }>);
    setData(res);
    setDraft((d) => (d.projectsRoot ? d : { name: res.report.profile.name ?? res.report.profile.suggestedName ?? "", projectsRoot: res.report.profile.projectsRoot }));
    setBusy(false);
  }, []);
  // Opening Get started again (from Settings or by hand) lifts an earlier "Skip for now".
  useEffect(() => void load().then(() => put("/api/start", { dismiss: false })), [load]);

  if (!data) return <div className="wrap"><p className="brief">Checking your Mac…</p></div>;

  const save = async (change: Record<string, unknown>) => {
    const res = await put<Progress>("/api/start", change);
    if (res.ok) {
      setData({ ...data, progress: res.data });
      setMessage(null);
    } else setMessage(res.error);
    return res.ok;
  };
  return (
    <StartView
      report={data.report}
      mail={mail}
      progress={data.progress}
      draft={draft}
      message={message}
      busy={busy}
      onDraft={setDraft}
      onGo={(step) => void save({ step })}
      onSkip={(step) => void save({ skip: step, step: nextStep(step) })}
      onRecheck={() => void load()}
      onSetupInvesting={async () => {
        const res = await post("/api/investing/setup");
        setMessage(res.ok ? "Investing is set up." : res.error);
        await load();
      }}
      onSaveProfile={async () => {
        const res = await put("/api/profile", { name: draft.name, projectsRoot: draft.projectsRoot });
        setMessage(res.ok ? "Saved." : res.error);
        await load();
      }}
      onDismiss={async () => {
        if (await save({ dismiss: true })) navigate("/");
      }}
      onFinish={async () => {
        if (await save({ done: true })) navigate("/");
      }}
    />
  );
}
