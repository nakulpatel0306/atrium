import { tagWord } from "../../engine/words";
import { Check, CircleCheck, CircleDashed, CircleX, Copy, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Check as Probe, Report } from "../../engine/doctor";
import { claudeBlocks, nextStep, prevStep, STEPS, type Progress, type Step } from "../../engine/start-steps";
import { post, put } from "../api";
import { navigate } from "../route";

export const STEP_TITLES: Record<Step, string> = {
  claude: "Claude",
  folder: "Projects folder",
  sample: "Try it once",
};

export type Sample = { ask: string; cents: number; seconds: number };

// A command to paste, with one-click copy; an instruction that isn't a command ("Install Antigravity…") stays text.
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (/^[A-Z]/.test(text)) return <span>{text}</span>;
  return (
    <span className="cmd-copy">
      <code>{text}</code>
      <button
        type="button"
        className="btn link subtle"
        aria-label={`Copy ${text}`}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

const STATE_TEXT: Record<Probe["state"], string> = { ready: "Ready", not_installed: "Not installed", too_old: "Too old", signed_out: "Signed out", unknown: "Couldn't check" };

function CheckRow({ check }: { check: Probe }) {
  // Git has nothing to sign in to; what it can lack is the name and email commits carry.
  const isGit = check.id === "git";
  const Icon = check.state === "ready" ? CircleCheck : check.required && !isGit ? CircleX : CircleDashed;
  return (
    <div className={`set-card start-check ${check.state}`}>
      <div className="set-title">
        <Icon className={check.state === "ready" ? "ok" : check.required && !isGit ? "bad" : "faint"} />
        <b>{check.label}</b>
        <span className={`tag${check.state === "ready" ? " ok" : ""}`}>
          {tagWord(isGit && check.state === "signed_out" ? "No name set" : STATE_TEXT[check.state])}
          {check.state === "ready" && check.version ? ` · ${check.version}` : ""}
        </span>
      </div>
      {check.state !== "ready" && <p className="hint">{check.message}</p>}
      {check.state === "not_installed" && (
        <p className="hint">
          Install: <Command text={check.install} />
        </p>
      )}
      {check.state !== "ready" && check.state !== "too_old" && !(isGit && check.state === "not_installed") && (
        <p className="hint">
          {isGit ? "Set it" : "Sign in"}: <Command text={check.signIn} />
        </p>
      )}
    </div>
  );
}

// The extras, one line each: what they add and how to get them. Nothing waits on them.
function Optional({ checks }: { checks: Probe[] }) {
  const adds: Record<string, string> = { codex: "a second-vendor reviewer", gemini: "another reviewer", gh: "pull requests and GitHub repos" };
  return (
    <ul className="start-optional">
      {checks.map((c) => (
        <li key={c.id}>
          {c.state === "ready" ? <CircleCheck className="ok" /> : <CircleDashed className="faint" />}
          <span>
            <b>{c.label}</b> <span className="hint">· {adds[c.id] ?? "optional"}</span>
          </span>
          {c.state === "ready" ? <span className="tag ok">ready</span> : <Command text={c.state === "not_installed" ? c.install : c.signIn} />}
        </li>
      ))}
    </ul>
  );
}

type ViewProps = {
  report: Report;
  progress: Progress;
  folder: string;
  sample: Sample;
  message: string | null;
  busy?: boolean;
  // The folder Next found isn't there yet, as the engine wrote it.
  missing?: string | null;
  onFolder(path: string): void;
  onGo(step: Step): void;
  onRecheck(): void;
  onSaveFolder(create?: boolean): void;
  onRunSample(): void;
  onFinish(): void;
};

// Three short steps: Claude, a folder, and the loop once on a demo repo. Everything it checks is what `atrium doctor`
// checks.
export function StartView(p: ViewProps) {
  const { report, progress } = p;
  const step = progress.step;
  const index = STEPS.indexOf(step);
  const blocked = claudeBlocks(report);
  const claude = report.agents.find((a) => a.id === "claude")!;
  return (
    <div className="wrap start">
      <h1>Get started</h1>
      <ol className="start-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === index ? "on" : i < index ? "past" : ""} aria-current={i === index ? "step" : undefined}>
            {STEP_TITLES[s]}
          </li>
        ))}
      </ol>
      {p.message && <p className="hint start-message">{p.message}</p>}

      {step === "claude" && (
        <>
          <p>Atrium runs your coding tasks through your own Claude CLI, on your Mac: a brief, the work, Atrium's own checks and a fresh review, then you.</p>
          <CheckRow check={claude} />
          {/* Never blocks: without a name and email git still commits, as your Mac's user and host name. */}
          <CheckRow check={report.git} />
          <button className="btn" onClick={p.onRecheck} disabled={p.busy}>
            Check again
          </button>
          <h2>Optional, any time</h2>
          <Optional checks={[...report.agents.filter((a) => !a.required), report.github]} />
        </>
      )}

      {step === "folder" && (
        <form
          className="mk-form"
          onSubmit={(e) => {
            e.preventDefault();
            p.onSaveFolder();
          }}
        >
          <label className="start-folder">
            Projects folder
            <input value={p.folder} spellCheck={false} onChange={(e) => p.onFolder(e.target.value)} />
          </label>
          <p className="hint">Where your repos live: Atrium finds them here, and new projects and clones go here. Change it later in Settings.</p>
          {p.missing && (
            <p className="start-missing" role="status">
              {p.missing} doesn't exist yet.
              <button type="button" className="btn p" disabled={p.busy} onClick={() => p.onSaveFolder(true)}>
                Create it
              </button>
            </p>
          )}
        </form>
      )}

      {step === "sample" && (
        <form
          className="start-sample"
          onSubmit={(e) => {
            e.preventDefault();
            p.onRunSample();
          }}
        >
          <p>
            Watch the loop once. Atrium copies a tiny demo repo with one failing test into its own folder, and your Claude CLI fixes it on its cheapest model: brief, write, checks, review, walkthrough, ready.
          </p>
          <label className="start-ask">
            <span className="sr-only">The sample's ask</span>
            <input value={p.sample.ask} readOnly autoFocus />
            <button className="btn p" type="submit" disabled={p.busy || blocked !== null}>
              <Play />
              Run it
            </button>
          </label>
          <p className="hint">
            {p.sample.seconds <= 60 ? "About a minute" : `About ${Math.ceil(p.sample.seconds / 60)} minutes`} and around {p.sample.cents}¢ at Anthropic's list prices (your subscription doesn't bill per token). Your own repos aren't touched.
          </p>
        </form>
      )}

      {blocked && step !== "claude" && <p className="hint">Claude comes first. {blocked}</p>}

      <div className="start-nav">
        {index > 0 && (
          <button className="btn" onClick={() => p.onGo(prevStep(step))}>
            Back
          </button>
        )}
        {step === "sample" ? (
          <button className="btn link" onClick={p.onFinish}>
            Skip, go to Home
          </button>
        ) : (
          <button className="btn p primary" onClick={() => (step === "folder" ? p.onSaveFolder() : p.onGo(nextStep(step)))} disabled={blocked !== null || p.busy}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}

export function GetStarted() {
  const [data, setData] = useState<{ report: Report; progress: Progress; sample: Sample } | null>(null);
  const [folder, setFolder] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const res = await fetch("/api/start").then((r) => r.json() as Promise<{ report: Report; progress: Progress; sample: Sample }>);
    setData(res);
    setFolder((f) => f || res.report.profile.projectsRoot);
    setBusy(false);
  }, []);
  // Opening Get started again (from Settings or by hand) lifts an earlier "Skip for now".
  useEffect(() => void load().then(() => put("/api/start", { dismiss: false })), [load]);

  if (!data) return <div className="wrap"><p className="brief">Checking your Mac…</p></div>;

  const go = async (step: Step) => {
    const res = await put<Progress>("/api/start", { step });
    if (res.ok) {
      setData({ ...data, progress: res.data });
      setMessage(null);
    } else setMessage(res.error);
  };
  return (
    <StartView
      report={data.report}
      progress={data.progress}
      folder={folder}
      sample={data.sample}
      message={message}
      busy={busy}
      onFolder={(path) => {
        setFolder(path);
        setMissing(null);
      }}
      onGo={(step) => void go(step)}
      onRecheck={() => void load()}
      missing={missing}
      onSaveFolder={async (create) => {
        const res = await put<{ missing?: string }>("/api/profile", { projectsRoot: folder, ...(create ? { create: true } : {}) });
        if (!res.ok) return setMessage(res.error);
        // Not there yet: nothing was saved, and the step offers to make it before moving on.
        if (res.data.missing) return setMissing(res.data.missing);
        setMissing(null);
        await go("sample");
      }}
      onRunSample={async () => {
        setBusy(true);
        const res = await post<{ spaceId: string; taskId: string }>("/api/start/sample");
        setBusy(false);
        if (!res.ok) return setMessage(res.error);
        navigate(`/space/${res.data.spaceId}?task=${res.data.taskId}`);
      }}
      onFinish={async () => {
        const res = await put<Progress>("/api/start", { done: true });
        if (res.ok) navigate("/");
        else setMessage(res.error);
      }}
    />
  );
}
