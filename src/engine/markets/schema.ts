// Tables for markets spaces. Prices and bars are keyed by instrument key (see instrument.ts), not by space,
// so two spaces watching the same symbol share one cached quote.
export const MARKETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS market_watchlist (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, symbol, exchange)
);
CREATE TABLE IF NOT EXISTS market_holdings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  account TEXT NOT NULL,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  book_value REAL,
  currency TEXT NOT NULL CHECK (currency IN ('CAD','USD')),
  source TEXT NOT NULL CHECK (source IN ('manual','wealthsimple_holdings','wealthsimple_activity')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_quotes (
  key TEXT PRIMARY KEY,
  price REAL NOT NULL,
  prev_close REAL,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  freshness TEXT NOT NULL CHECK (freshness IN ('live','eod','demo')),
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_bars (
  key TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  t INTEGER NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  v REAL NOT NULL,
  PRIMARY KEY (key, timeframe, t)
);
CREATE TABLE IF NOT EXISTS market_alerts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  key TEXT NOT NULL,
  rule TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  repeat INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed','fired','off')),
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_accounts (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id),
  starting_cash REAL NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_fills (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  qty REAL NOT NULL,
  price REAL NOT NULL,
  quote_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  actor TEXT NOT NULL,
  strategy_id TEXT,
  task_id TEXT,
  reasoning TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_strategies (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  name TEXT NOT NULL,
  rules TEXT NOT NULL,
  symbols TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('open','hourly','close')),
  max_position_value REAL NOT NULL,
  max_trades_per_day INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','rejected')),
  approval_id TEXT,
  last_run_at INTEGER,
  -- The schedule slot last enqueued, so a slot runs at most once.
  last_slot_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_fills_space ON paper_fills(space_id, created_at);
`;
