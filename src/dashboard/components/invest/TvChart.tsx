import { WifiOff } from "lucide-react";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { CHART_TIMEOUT_MS, chartReducer, embedUrl, type ChartState } from "../../simple";

const PRIVACY = "TradingView sees which symbols you open, never your holdings.";
const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

export function ChartCard({ state, onRetry, onFallback }: { state: ChartState; onRetry: () => void; onFallback: () => void }) {
  return (
    <div className="tv-card" role="status">
      <WifiOff aria-hidden />
      <p>{state === "offline" ? "The chart needs the internet. Prices below are Atrium's last saved ones." : "The chart didn't load. TradingView may be down or blocked."}</p>
      <div className="tv-card-acts">
        <button className="btn p" onClick={onRetry}>
          Try again
        </button>
        <button className="btn" onClick={onFallback}>
          Show Atrium's chart
        </button>
      </div>
    </div>
  );
}

export function TvChart({
  tv,
  coverage,
  fallback,
  frameUrl = embedUrl,
  timeoutMs = CHART_TIMEOUT_MS,
}: {
  tv: string;
  coverage: { ok: true } | { ok: false; reason: string };
  fallback: ReactNode;
  frameUrl?: (tv: string) => string;
  timeoutMs?: number;
}) {
  const [state, send] = useReducer(chartReducer, isOnline() ? "loading" : "offline");
  const [ours, setOurs] = useState(false);
  // Each Try again remounts the frame with a fresh 12 s timeout.
  const [attempt, setAttempt] = useState(0);
  const src = frameUrl(tv);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!coverage.ok || ours) return;
    send({ type: "start", online: isOnline() });
    const origin = new URL(src).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow || e.data?.type !== "atrium-tv") return;
      if (e.data.state === "loaded") send({ type: "loaded" });
      if (e.data.state === "failed") send({ type: "failed" });
    };
    const onOffline = () => send({ type: "offline" });
    const onOnline = () => send({ type: "online" });
    const timer = setTimeout(() => send({ type: "timeout" }), timeoutMs);
    addEventListener("message", onMessage);
    addEventListener("offline", onOffline);
    addEventListener("online", onOnline);
    return () => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      removeEventListener("offline", onOffline);
      removeEventListener("online", onOnline);
    };
  }, [src, coverage.ok, ours, attempt, timeoutMs]);

  if (!coverage.ok) {
    return (
      <div className="tv-wrap">
        <p className="tv-reason">{coverage.reason}</p>
        {fallback}
      </div>
    );
  }
  const retry = () => {
    send({ type: "retry", online: isOnline() });
    setAttempt((n) => n + 1);
  };
  const down = state === "offline" || state === "failed";
  return (
    <div className="tv-wrap">
      {ours ? (
        fallback
      ) : down ? (
        <div className="tv-chart">
          <ChartCard state={state} onRetry={retry} onFallback={() => setOurs(true)} />
        </div>
      ) : (
        <div className="tv-chart">
          <iframe
            key={attempt}
            ref={frame}
            title={`${tv} chart by TradingView`}
            src={src}
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="origin"
            loading="lazy"
          />
        </div>
      )}
      <div className="tv-labels">
        <span>{ours ? "Atrium · daily closes" : "TradingView · delayed"}</span>
        <button className="btn link" onClick={() => setOurs(!ours)}>
          {ours ? "Show TradingView" : "Show Atrium's chart"}
        </button>
        <span className="tv-privacy">{PRIVACY}</span>
      </div>
    </div>
  );
}
