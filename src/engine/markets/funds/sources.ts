import { NDX_WIKI_URL } from "./nasdaq100";

// Where each fund's holdings file comes from. XEQT's iShares file carries iShares' own look-through of its sleeves,
// so the sleeves need no entries of their own.
export type FundSource =
  | { kind: "ishares-ca" | "ishares-us"; productId: string; slug: string; ticker: string }
  | { kind: "ssga"; ticker: string }
  | { kind: "roundhill"; ticker: string }
  | { kind: "qqq" }
  | { kind: "alias"; of: string; note: string };

export const FUND_SOURCES: Record<string, FundSource> = {
  "XEQT.TO": { kind: "ishares-ca", productId: "309480", slug: "ishares-core-equity-etf-portfolio", ticker: "XEQT" },
  SPY: { kind: "ssga", ticker: "spy" },
  MARS: { kind: "roundhill", ticker: "MARS" },
  DRAM: { kind: "roundhill", ticker: "DRAM" },
  QQQ: { kind: "qqq" },
  "VFV.TO": { kind: "alias", of: "SPY", note: "VFV holds Vanguard's US S&P 500 ETF, so it's shown through SPY's holdings (same index)." },
};

export const INVESCO_QQQ_URL = "https://www.invesco.com/us/financial-products/etfs/holdings/main/holdings/0?audienceType=Investor&action=download&ticker=QQQ";
export { NDX_WIKI_URL };

// Roundhill's file is dated, so its URL is built per day in refresh.ts.
export function fundUrl(src: FundSource): string | null {
  switch (src.kind) {
    case "ishares-ca":
      return `https://www.blackrock.com/ca/investors/en/products/${src.productId}/${src.slug}/1464253357814.ajax?fileType=csv&fileName=${src.ticker}_holdings&dataType=fund`;
    case "ishares-us":
      return `https://www.ishares.com/us/products/${src.productId}/${src.slug}/1467271812596.ajax?fileType=csv&fileName=${src.ticker}_holdings&dataType=fund`;
    case "ssga":
      return `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${src.ticker}.xlsx`;
    case "qqq":
      return INVESCO_QQQ_URL;
    default:
      return null;
  }
}

export const isFund = (key: string): boolean => key in FUND_SOURCES;

// The fund whose file stands for this one (VFV.TO → SPY).
export const fileFundFor = (key: string): string => {
  const s = FUND_SOURCES[key];
  return s?.kind === "alias" ? s.of : key;
};
