// Tables for markets spaces. Prices and bars are keyed by instrument key (see instrument.ts), not by space,
// so two spaces watching the same symbol share one cached quote.
export const MARKETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS market_lists (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_watchlist (
  list_id TEXT NOT NULL REFERENCES market_lists(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, symbol, exchange)
);
CREATE INDEX IF NOT EXISTS market_watchlist_space ON market_watchlist(space_id);
CREATE TABLE IF NOT EXISTS market_holdings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  account TEXT NOT NULL,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  book_value REAL,
  book_value_cad REAL,
  account_type TEXT,
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
  fired_for TEXT,
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
CREATE TABLE IF NOT EXISTS fx_rates (
  pair TEXT NOT NULL,
  date TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (pair, date)
);
-- Atrium's own daily closes, so history grows without extra calls.
CREATE TABLE IF NOT EXISTS market_closes (
  key TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  adj_close REAL,
  source TEXT NOT NULL,
  PRIMARY KEY (key, date)
);
CREATE TABLE IF NOT EXISTS market_dividends (
  key TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  amount REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (key, ex_date)
);
-- The last good issuer holdings file per fund; a failed refresh only records its error.
CREATE TABLE IF NOT EXISTS fund_files (
  fund TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  note TEXT,
  last_error TEXT,
  last_attempt_at INTEGER
);
CREATE TABLE IF NOT EXISTS fund_lines (
  fund TEXT NOT NULL,
  rank INTEGER NOT NULL,
  ticker TEXT,
  key TEXT,
  name TEXT NOT NULL,
  weight REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stock','fund','cash','other')),
  sector TEXT,
  country TEXT,
  currency TEXT,
  via TEXT,
  PRIMARY KEY (fund, rank)
);
CREATE TABLE IF NOT EXISTS instrument_meta (
  key TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('stock','etf','unknown')),
  sector TEXT,
  sector_source TEXT,
  country TEXT,
  currency TEXT,
  pe REAL,
  high52 REAL,
  low52 REAL,
  div_yield REAL,
  metrics_at INTEGER,
  profile_at INTEGER,
  edgar_eps_ttm REAL,
  edgar_at INTEGER,
  listing TEXT,
  market_cap REAL
);
CREATE TABLE IF NOT EXISTS market_earnings (
  key TEXT NOT NULL,
  date TEXT NOT NULL,
  hour TEXT,
  eps_estimate REAL,
  source TEXT NOT NULL CHECK (source IN ('finnhub','you')),
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (key, date)
);
CREATE TABLE IF NOT EXISTS market_news (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  headline TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE (key, url)
);
CREATE TABLE IF NOT EXISTS research_notes (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  key TEXT NOT NULL,
  thesis TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, key)
);
CREATE TABLE IF NOT EXISTS market_writeups (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('digest','thesis_draft','thesis_check','ask','money')),
  key TEXT,
  for_date TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (space_id, kind, key, for_date)
);
CREATE TABLE IF NOT EXISTS market_ideas (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('watching','researching','owned','sold')),
  note TEXT NOT NULL DEFAULT '',
  stage_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, key)
);
CREATE TABLE IF NOT EXISTS tfsa_room (
  year INTEGER PRIMARY KEY,
  room_jan1 REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tfsa_entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contribution','withdrawal')),
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS money_transactions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  source TEXT NOT NULL CHECK (source IN ('bank','wealthsimple')),
  account TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  kind TEXT NOT NULL,
  symbol TEXT,
  fingerprint TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  UNIQUE (space_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS money_transactions_date ON money_transactions(space_id, date);
CREATE TABLE IF NOT EXISTS money_imports (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  account TEXT NOT NULL,
  first_date TEXT NOT NULL,
  last_date TEXT NOT NULL,
  rows INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  period_start TEXT,
  period_end TEXT
);
CREATE TABLE IF NOT EXISTS money_budgets (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  category TEXT NOT NULL,
  monthly_limit REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, category)
);
CREATE TABLE IF NOT EXISTS money_nudges (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('budget','import')),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER,
  UNIQUE (space_id, key)
);
`;
