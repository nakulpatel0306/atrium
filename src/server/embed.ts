import { isTvSymbol, tvSymbolUrl } from "../engine/markets/tradingview";

// TradingView's Advanced Chart widget, isolated. This page is served by a listener of its own on the engine's port
// + 1, under the other loopback name (127.0.0.1 ↔ localhost), and that listener has no API. TradingView's code runs
// cross-origin: it can't read the dashboard's DOM (holdings) or call the engine, and the dashboard document itself
// loads nothing external. The query carries only the symbol and the parent origin. A CSP sandbox (opaque origin)
// was tried and stops the widget rendering, which is why the isolation is by origin instead.
const EMBEDDING = "https://s3.tradingview.com/external-embedding";
// TradingView's free widgets in their iframe format, one script each. Every one injects its own frame from
// TV_FRAME_HOSTS and keeps TradingView's attribution under it.
export const TV_SCRIPTS = {
  chart: `${EMBEDDING}/embed-widget-advanced-chart.js`,
  mini: `${EMBEDDING}/embed-widget-mini-symbol-overview.js`,
  info: `${EMBEDDING}/embed-widget-symbol-info.js`,
  profile: `${EMBEDDING}/embed-widget-symbol-profile.js`,
  financials: `${EMBEDDING}/embed-widget-financials.js`,
  timeline: `${EMBEDDING}/embed-widget-timeline.js`,
} as const;
export type TvWidget = keyof typeof TV_SCRIPTS;
export const TV_SCRIPT = TV_SCRIPTS.chart;
const ATTRIBUTION: Record<TvWidget, string> = { chart: "chart", mini: "price", info: "price", profile: "profile", financials: "fundamentals", timeline: "news" };
export const TV_FRAME_HOSTS = ["https://www.tradingview-widget.com", "https://s.tradingview.com"];

const REFUSED = "That chart link isn't valid. Open the symbol from Atrium again.";

export function tvConfig(symbol: string): Record<string, unknown> {
  return {
    autosize: true,
    symbol,
    interval: "D",
    timezone: "America/Toronto",
    theme: "dark",
    style: "1",
    locale: "en",
    backgroundColor: "rgba(13, 13, 15, 1)",
    gridColor: "rgba(38, 38, 44, 1)",
    allow_symbol_change: false,
    calendar: false,
    hide_side_toolbar: true,
    hide_volume: false,
    save_image: false,
    details: false,
    hotlist: false,
    withdateranges: true,
    support_host: "https://www.tradingview.com",
  };
}

// Transparent widgets paint a white backdrop inside TradingView's own frame, so every one is opaque and dark.
const common = { colorTheme: "dark", isTransparent: false, locale: "en" };

export function widgetConfig(w: TvWidget, symbol: string): Record<string, unknown> {
  switch (w) {
    case "chart":
      return tvConfig(symbol);
    case "mini":
      return { ...common, symbol, width: "100%", height: "100%", autosize: true, dateRange: "1M", chartOnly: true, noTimeScale: true, largeChartUrl: "" };
    case "info":
      return { ...common, symbol, width: "100%" };
    case "profile":
      return { ...common, symbol, width: "100%", height: "100%" };
    case "financials":
      return { ...common, symbol, width: "100%", height: "100%", displayMode: "regular", largeChartUrl: "" };
    case "timeline":
      return { ...common, symbol, feedMode: "symbol", width: "100%", height: "100%", displayMode: "regular" };
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Tells the dashboard whether the widget's frame loaded, so it can show the offline card instead of a blank box.
const statusScript = (parent: string) => `
  const PARENT = ${JSON.stringify(parent)};
  const post = (state) => parent.postMessage({ type: "atrium-tv", state }, PARENT);
  const box = document.querySelector(".tradingview-widget-container");
  const seen = new MutationObserver(() => {
    const frame = box.querySelector("iframe");
    if (!frame) return;
    seen.disconnect();
    frame.addEventListener("load", () => post("loaded"), { once: true });
  });
  seen.observe(box, { childList: true, subtree: true });
  window.addEventListener(
    "error",
    (e) => {
      const t = e.target;
      if (t && t.tagName === "SCRIPT" && t.src.startsWith(${JSON.stringify(EMBEDDING)})) post("failed");
    },
    true,
  );
`;

function refuse(): Response {
  return new Response(REFUSED, { status: 400, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
}

export function embedResponse(req: Request, url: URL, port: number): Response {
  const symbol = url.searchParams.get("symbol") ?? "";
  const parent = url.searchParams.get("parent") ?? "";
  const w = (url.searchParams.get("w") ?? "chart") as TvWidget;
  const self = `http://${req.headers.get("host") ?? ""}`;
  const loopback = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  // A same-origin embed would put TradingView's code next to the dashboard; it must be the other loopback name.
  if (!isTvSymbol(symbol) || !loopback.includes(parent) || parent === self || !Object.hasOwn(TV_SCRIPTS, w)) return refuse();

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const sym = symbol.includes(":") ? symbol.split(":")[1]! : symbol;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://s3.tradingview.com`,
    `frame-src ${TV_FRAME_HOSTS.join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${parent}`,
  ].join("; ");
  const config = JSON.stringify(widgetConfig(w, symbol)).replace(/</g, "\\u003c");
  const label = `${sym} ${ATTRIBUTION[w]}`;
  // The chart paints its own background; the smaller widgets sit on whatever row or card frames them.
  const background = w === "chart" ? "#0d0d0f" : "transparent";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(label)}</title>
<style>
  html, body { margin: 0; height: 100%; background: ${background}; color-scheme: dark; }
  .tradingview-widget-container { height: 100%; display: flex; flex-direction: column; }
  .tradingview-widget-container__widget { flex: 1; min-height: 0; }
  .tradingview-widget-copyright { font: 13px/20px -apple-system, system-ui, sans-serif; color: #8a8a94; padding: 4px 8px; }
  .tradingview-widget-copyright a { color: #8a8a94; text-decoration: none; }
  .tradingview-widget-copyright .blue-text { color: #8fa8ff; }${w === "mini" ? "\n  .tradingview-widget-copyright { padding: 0 2px; line-height: 15px; white-space: nowrap; }" : ""}
</style>
</head>
<body>
<div class="tradingview-widget-container">
  <div class="tradingview-widget-container__widget"></div>
  <div class="tradingview-widget-copyright"><a href="${escapeHtml(tvSymbolUrl(symbol))}" rel="noopener nofollow" target="_blank"><span class="blue-text">${escapeHtml(label)}</span></a> by TradingView</div>
  <script nonce="${nonce}">${statusScript(parent)}</script>
  <script src="${TV_SCRIPTS[w]}" async>${config}</script>
</div>
</body>
</html>
`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "referrer-policy": "origin",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
