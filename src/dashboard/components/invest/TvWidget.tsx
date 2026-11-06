import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useEngineState } from "../../api";
import { CHART_TIMEOUT_MS, chartReducer, embedUrl, type TvWidget as Kind } from "../../simple";

const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

// A small TradingView widget (row chart, profile, fundamentals, news) in the isolated chart listener. It loads only
// once scrolled into view, and shows `fallback` when there's no chart listener, the network is down, or it doesn't
// load within the timeout. Nothing retries by itself.
export function TvWidget({
  tv,
  kind,
  fallback,
  className,
  title,
  frameUrl,
  timeoutMs = CHART_TIMEOUT_MS,
}: {
  tv: string;
  kind: Exclude<Kind, "chart">;
  fallback: ReactNode;
  className: string;
  title: string;
  frameUrl?: ((tv: string) => string) | null;
  timeoutMs?: number;
}) {
  const embed = useEngineState()?.embed ?? null;
  const url = frameUrl !== undefined ? frameUrl : embed ? (t: string) => embedUrl(t, embed, location, kind) : null;
  const src = url ? url(tv) : "";
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [seen, setSeen] = useState(false);
  const [state, send] = useReducer(chartReducer, isOnline() ? "loading" : "offline");

  useEffect(() => {
    if (!src || seen || !box.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    io.observe(box.current);
    return () => io.disconnect();
  }, [src, seen]);

  useEffect(() => {
    if (!src || !seen) return;
    send({ type: "start", online: isOnline() });
    const origin = new URL(src).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow || e.data?.type !== "atrium-tv") return;
      send({ type: e.data.state === "loaded" ? "loaded" : "failed" });
    };
    const timer = setTimeout(() => send({ type: "timeout" }), timeoutMs);
    addEventListener("message", onMessage);
    return () => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
    };
  }, [src, seen, timeoutMs]);

  if (!src || state === "offline" || state === "failed") return <>{fallback}</>;
  return (
    <div ref={box} className={`tvw ${className}`}>
      {seen && <iframe ref={frame} title={title} src={src} sandbox="allow-scripts allow-same-origin allow-popups" referrerPolicy="origin" />}
    </div>
  );
}
