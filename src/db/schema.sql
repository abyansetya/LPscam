PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  position_count INTEGER DEFAULT 0,
  event_count INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS pools (
  pool_address TEXT PRIMARY KEY,
  pair_name TEXT,
  token0_mint TEXT,
  token0_symbol TEXT,
  token0_decimals INTEGER,
  token1_mint TEXT,
  token1_symbol TEXT,
  token1_decimals INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  position_address TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  status TEXT NOT NULL,
  protocol TEXT NOT NULL,
  lower_bin_id INTEGER,
  upper_bin_id INTEGER,
  active_bin_id INTEGER,
  in_range INTEGER,
  current_amount0_raw TEXT,
  current_amount1_raw TEXT,
  unclaimed_fee0_raw TEXT,
  unclaimed_fee1_raw TEXT,
  account_json TEXT,
  sources_json TEXT,
  onchain_updated_at TEXT,
  synced_at TEXT NOT NULL,
  FOREIGN KEY (pool_address) REFERENCES pools(pool_address)
);

CREATE TABLE IF NOT EXISTS position_events (
  event_key TEXT PRIMARY KEY,
  position_address TEXT NOT NULL,
  owner TEXT NOT NULL,
  pool_address TEXT,
  signature TEXT NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  timestamp TEXT,
  outer_instruction_index INTEGER,
  inner_instruction_index INTEGER,
  instruction TEXT,
  event_type TEXT,
  action_type TEXT,
  accounting_source TEXT,
  amount0_raw TEXT,
  amount1_raw TEXT,
  input0_raw TEXT,
  input1_raw TEXT,
  output0_raw TEXT,
  output1_raw TEXT,
  pool_delta0_raw TEXT,
  pool_delta1_raw TEXT,
  active_bin_id INTEGER,
  old_lower_bin_id INTEGER,
  old_upper_bin_id INTEGER,
  new_lower_bin_id INTEGER,
  new_upper_bin_id INTEGER,
  claimed_fee0_raw TEXT,
  claimed_fee1_raw TEXT,
  claimed_reward_raw TEXT,
  reward_index INTEGER,
  reserve_delta_check_matches INTEGER,
  reserve_delta_check_json TEXT,
  decoded_event_json TEXT,
  decoded_events_json TEXT,
  price0_json TEXT,
  price1_json TEXT,
  input_value_usd REAL,
  output_value_usd REAL,
  sync_run_id INTEGER,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (position_address) REFERENCES positions(position_address),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_position_events_position_time
  ON position_events(position_address, block_time, outer_instruction_index, inner_instruction_index);

CREATE INDEX IF NOT EXISTS idx_position_events_signature
  ON position_events(signature);

CREATE TABLE IF NOT EXISTS historical_prices (
  price_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  token_address TEXT NOT NULL,
  requested_timestamp INTEGER,
  value REAL,
  price_unix_time INTEGER,
  distance_seconds INTEGER,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS position_metrics (
  position_address TEXT PRIMARY KEY,
  input0_raw TEXT,
  input1_raw TEXT,
  output0_raw TEXT,
  output1_raw TEXT,
  input_value_usd REAL,
  output_value_usd REAL,
  current_value_usd REAL,
  unclaimed_fee_usd REAL,
  collected_fee_usd REAL,
  pnl_usd REAL,
  pnl_percent REAL,
  event_count INTEGER NOT NULL,
  sync_run_id INTEGER,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (position_address) REFERENCES positions(position_address),
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(id)
);
