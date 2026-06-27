const fs = require("fs");
const path = require("path");
const { getOpenPositionsForWallet } = require("../src/services/onchainOpenPositions.cjs");
const {
  ensureDatabase,
  runTransaction,
  selectJson,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlReal,
  sqlText,
} = require("../src/db/sqliteCli.cjs");

function readEnv(filePath) {
  const env = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const index = line.indexOf("=");
    if (index === -1) continue;

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function eventKey(position, event) {
  const decoded = event.decodedDlmmEvent || {};
  const outer = decoded.outerInstructionIndex ?? "flow";
  const inner = decoded.innerInstructionIndex ?? "flow";
  const eventType = event.eventType || "reserve_delta";
  return [event.signature, outer, inner, eventType, position.position].join(":");
}

function priceKey(price) {
  return [
    price.source || "unknown",
    price.tokenAddress || "unknown",
    price.timestamp ?? "unknown",
    price.priceUnixTime ?? "missing",
  ].join(":");
}

async function fetchLpagentStrategyType(lpagentKey, owner, position) {
  if (!lpagentKey || !owner || !position) return null;

  const url =
    `https://api.lpagent.io/open-api/v1/lp-positions/logs?owner=${encodeURIComponent(owner)}` +
    `&position=${encodeURIComponent(position)}`;
  const response = await fetch(url, {
    headers: {
      "x-api-key": lpagentKey,
      accept: "application/json",
    },
  }).catch(() => null);
  if (!response || !response.ok) return null;

  const payload = await response.json().catch(() => null);
  const log = payload && Array.isArray(payload.data)
    ? payload.data.find((entry) => entry && entry.strategyType)
    : null;
  return log ? log.strategyType : null;
}

async function enrichPositionMetadata(position, env) {
  const lpagentKey = env.VITE_LPAGENT_API_KEY || env.LPAGENT_API_KEY;
  const strategyType = await fetchLpagentStrategyType(lpagentKey, position.owner, position.position);
  if (!strategyType) return position;

  return {
    ...position,
    strategyType,
    sources: {
      ...position.sources,
      strategyType,
      strategyTypeSource: "lpagent_open_api_logs",
    },
  };
}

function upsertPool(position, now) {
  return `
INSERT INTO pools (
  pool_address, pair_name,
  token0_mint, token0_symbol, token0_decimals,
  token1_mint, token1_symbol, token1_decimals,
  updated_at
) VALUES (
  ${sqlText(position.pool)}, ${sqlText(position.pairName)},
  ${sqlText(position.token0 && position.token0.mint)},
  ${sqlText(position.token0 && position.token0.symbol)},
  ${sqlInteger(position.token0 && position.token0.decimals)},
  ${sqlText(position.token1 && position.token1.mint)},
  ${sqlText(position.token1 && position.token1.symbol)},
  ${sqlInteger(position.token1 && position.token1.decimals)},
  ${sqlText(now)}
)
ON CONFLICT(pool_address) DO UPDATE SET
  pair_name = excluded.pair_name,
  token0_mint = excluded.token0_mint,
  token0_symbol = excluded.token0_symbol,
  token0_decimals = excluded.token0_decimals,
  token1_mint = excluded.token1_mint,
  token1_symbol = excluded.token1_symbol,
  token1_decimals = excluded.token1_decimals,
  updated_at = excluded.updated_at;
`;
}

function upsertPosition(position, now) {
  return `
INSERT INTO positions (
  position_address, owner, pool_address, status, protocol,
  lower_bin_id, upper_bin_id, active_bin_id, in_range,
  current_amount0_raw, current_amount1_raw,
  unclaimed_fee0_raw, unclaimed_fee1_raw,
  account_json, sources_json, onchain_updated_at, synced_at
) VALUES (
  ${sqlText(position.position)}, ${sqlText(position.owner)}, ${sqlText(position.pool)},
  ${sqlText(position.status)}, ${sqlText(position.protocol)},
  ${sqlInteger(position.range && position.range.lowerBinId)},
  ${sqlInteger(position.range && position.range.upperBinId)},
  ${sqlInteger(position.range && position.range.activeBinId)},
  ${sqlBoolean(position.range && position.range.inRange)},
  ${sqlText(position.current && position.current.amount0Raw)},
  ${sqlText(position.current && position.current.amount1Raw)},
  ${sqlText(position.fees && position.fees.unclaimedFee0Raw)},
  ${sqlText(position.fees && position.fees.unclaimedFee1Raw)},
  ${sqlJson(position.account)}, ${sqlJson(position.sources)},
  ${sqlText(position.updatedAt)}, ${sqlText(now)}
)
ON CONFLICT(position_address) DO UPDATE SET
  owner = excluded.owner,
  pool_address = excluded.pool_address,
  status = excluded.status,
  protocol = excluded.protocol,
  lower_bin_id = excluded.lower_bin_id,
  upper_bin_id = excluded.upper_bin_id,
  active_bin_id = excluded.active_bin_id,
  in_range = excluded.in_range,
  current_amount0_raw = excluded.current_amount0_raw,
  current_amount1_raw = excluded.current_amount1_raw,
  unclaimed_fee0_raw = excluded.unclaimed_fee0_raw,
  unclaimed_fee1_raw = excluded.unclaimed_fee1_raw,
  account_json = excluded.account_json,
  sources_json = excluded.sources_json,
  onchain_updated_at = excluded.onchain_updated_at,
  synced_at = excluded.synced_at;
`;
}

function upsertEvent(position, event, syncRunId, now) {
  const decoded = event.decodedDlmmEvent || {};
  const reserveMatch =
    event.reserveDeltaCheck && typeof event.reserveDeltaCheck.matches === "boolean"
      ? event.reserveDeltaCheck.matches
      : null;

  return `
INSERT INTO position_events (
  event_key, position_address, owner, pool_address,
  signature, slot, block_time, timestamp,
  outer_instruction_index, inner_instruction_index,
  instruction, event_type, action_type, accounting_source,
  amount0_raw, amount1_raw,
  input0_raw, input1_raw, output0_raw, output1_raw,
  pool_delta0_raw, pool_delta1_raw,
  active_bin_id,
  old_lower_bin_id, old_upper_bin_id, new_lower_bin_id, new_upper_bin_id,
  claimed_fee0_raw, claimed_fee1_raw, claimed_reward_raw, reward_index,
  reserve_delta_check_matches, reserve_delta_check_json,
  decoded_event_json, decoded_events_json,
  price0_json, price1_json,
  input_value_usd, output_value_usd,
  sync_run_id, inserted_at, updated_at
) VALUES (
  ${sqlText(eventKey(position, event))},
  ${sqlText(position.position)}, ${sqlText(position.owner)}, ${sqlText(position.pool)},
  ${sqlText(event.signature)}, ${sqlInteger(event.slot)}, ${sqlInteger(event.blockTime)}, ${sqlText(event.timestamp)},
  ${sqlInteger(decoded.outerInstructionIndex)}, ${sqlInteger(decoded.innerInstructionIndex)},
  ${sqlText(event.instruction)}, ${sqlText(event.eventType)}, ${sqlText(event.actionType)}, ${sqlText(event.accountingSource)},
  ${sqlText(decoded.amount0Raw ?? event.input0)}, ${sqlText(decoded.amount1Raw ?? event.input1)},
  ${sqlText(event.input0)}, ${sqlText(event.input1)}, ${sqlText(event.output0)}, ${sqlText(event.output1)},
  ${sqlText(event.poolDelta0)}, ${sqlText(event.poolDelta1)},
  ${sqlInteger(decoded.activeBinId)},
  ${sqlInteger(decoded.oldLowerBinId)}, ${sqlInteger(decoded.oldUpperBinId)},
  ${sqlInteger(decoded.newLowerBinId)}, ${sqlInteger(decoded.newUpperBinId)},
  ${sqlText(event.claimedFee0Raw ?? decoded.claimedFee0Raw)},
  ${sqlText(event.claimedFee1Raw ?? decoded.claimedFee1Raw)},
  ${sqlText(event.claimedRewardRaw ?? decoded.claimedRewardRaw)},
  ${sqlInteger(event.rewardIndex ?? decoded.rewardIndex)},
  ${sqlBoolean(reserveMatch)}, ${sqlJson(event.reserveDeltaCheck)},
  ${sqlJson(event.decodedDlmmEvent)}, ${sqlJson(event.decodedDlmmEvents)},
  ${sqlJson(event.price0)}, ${sqlJson(event.price1)},
  ${sqlReal(event.inputValueUsd)}, ${sqlReal(event.outputValueUsd)},
  ${sqlInteger(syncRunId)}, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(event_key) DO UPDATE SET
  owner = excluded.owner,
  pool_address = excluded.pool_address,
  slot = excluded.slot,
  block_time = excluded.block_time,
  timestamp = excluded.timestamp,
  instruction = excluded.instruction,
  event_type = excluded.event_type,
  action_type = excluded.action_type,
  accounting_source = excluded.accounting_source,
  amount0_raw = excluded.amount0_raw,
  amount1_raw = excluded.amount1_raw,
  input0_raw = excluded.input0_raw,
  input1_raw = excluded.input1_raw,
  output0_raw = excluded.output0_raw,
  output1_raw = excluded.output1_raw,
  pool_delta0_raw = excluded.pool_delta0_raw,
  pool_delta1_raw = excluded.pool_delta1_raw,
  active_bin_id = excluded.active_bin_id,
  old_lower_bin_id = excluded.old_lower_bin_id,
  old_upper_bin_id = excluded.old_upper_bin_id,
  new_lower_bin_id = excluded.new_lower_bin_id,
  new_upper_bin_id = excluded.new_upper_bin_id,
  claimed_fee0_raw = excluded.claimed_fee0_raw,
  claimed_fee1_raw = excluded.claimed_fee1_raw,
  claimed_reward_raw = excluded.claimed_reward_raw,
  reward_index = excluded.reward_index,
  reserve_delta_check_matches = excluded.reserve_delta_check_matches,
  reserve_delta_check_json = excluded.reserve_delta_check_json,
  decoded_event_json = excluded.decoded_event_json,
  decoded_events_json = excluded.decoded_events_json,
  price0_json = excluded.price0_json,
  price1_json = excluded.price1_json,
  input_value_usd = excluded.input_value_usd,
  output_value_usd = excluded.output_value_usd,
  sync_run_id = excluded.sync_run_id,
  updated_at = excluded.updated_at;
`;
}

function upsertHistoricalPrice(price, now) {
  if (!price || !price.source || !price.tokenAddress) return null;

  return `
INSERT INTO historical_prices (
  price_key, source, token_address, requested_timestamp,
  value, price_unix_time, distance_seconds, raw_json, updated_at
) VALUES (
  ${sqlText(priceKey(price))}, ${sqlText(price.source)}, ${sqlText(price.tokenAddress)},
  ${sqlInteger(price.timestamp)}, ${sqlReal(price.value)}, ${sqlInteger(price.priceUnixTime)},
  ${sqlInteger(price.distanceSeconds)}, ${sqlJson(price)}, ${sqlText(now)}
)
ON CONFLICT(price_key) DO UPDATE SET
  value = excluded.value,
  price_unix_time = excluded.price_unix_time,
  distance_seconds = excluded.distance_seconds,
  raw_json = excluded.raw_json,
  updated_at = excluded.updated_at;
`;
}

function upsertMetrics(position, syncRunId, now) {
  const accounting = position.accounting || {};
  return `
INSERT INTO position_metrics (
  position_address,
  input0_raw, input1_raw, output0_raw, output1_raw,
  input_value_usd, output_value_usd, current_value_usd,
  unclaimed_fee_usd, collected_fee_usd,
  pnl_usd, pnl_percent, event_count,
  sync_run_id, updated_at
) VALUES (
  ${sqlText(position.position)},
  ${sqlText(accounting.input0Raw)}, ${sqlText(accounting.input1Raw)},
  ${sqlText(accounting.output0Raw)}, ${sqlText(accounting.output1Raw)},
  ${sqlReal(accounting.inputValueUsd)}, ${sqlReal(accounting.outputValueUsd)},
  ${sqlReal(accounting.currentValueUsd)}, ${sqlReal(accounting.unclaimedFeeUsd)},
  ${sqlReal(accounting.collectedFeeUsd)}, ${sqlReal(accounting.pnlUsd)},
  ${sqlReal(accounting.pnlPercent)}, ${sqlInteger(position.events.length)},
  ${sqlInteger(syncRunId)}, ${sqlText(now)}
)
ON CONFLICT(position_address) DO UPDATE SET
  input0_raw = excluded.input0_raw,
  input1_raw = excluded.input1_raw,
  output0_raw = excluded.output0_raw,
  output1_raw = excluded.output1_raw,
  input_value_usd = excluded.input_value_usd,
  output_value_usd = excluded.output_value_usd,
  current_value_usd = excluded.current_value_usd,
  unclaimed_fee_usd = excluded.unclaimed_fee_usd,
  collected_fee_usd = excluded.collected_fee_usd,
  pnl_usd = excluded.pnl_usd,
  pnl_percent = excluded.pnl_percent,
  event_count = excluded.event_count,
  sync_run_id = excluded.sync_run_id,
  updated_at = excluded.updated_at;
`;
}

function createSyncRun(dbPath, owner, now) {
  runTransaction(dbPath, [
    `INSERT INTO sync_runs (owner, status, started_at) VALUES (${sqlText(owner)}, 'running', ${sqlText(now)});`,
  ]);
  const rows = selectJson(
    dbPath,
    `
SELECT id
FROM sync_runs
WHERE owner = ${sqlText(owner)}
  AND started_at = ${sqlText(now)}
ORDER BY id DESC
LIMIT 1;
`,
  );
  return rows[0].id;
}

function finishSyncRun(dbPath, syncRunId, status, finishedAt, counts, error = null) {
  runTransaction(dbPath, [
    `
UPDATE sync_runs SET
  status = ${sqlText(status)},
  finished_at = ${sqlText(finishedAt)},
  position_count = ${sqlInteger(counts.positionCount)},
  event_count = ${sqlInteger(counts.eventCount)},
  error = ${sqlText(error)}
WHERE id = ${sqlInteger(syncRunId)};
`,
  ]);
}

async function main() {
  const owner = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]);
  if (!owner) {
    throw new Error("Usage: node scripts/ingest-onchain-sqlite.cjs <owner> [--db=data/lpscan.sqlite]");
  }

  const dbPath = path.resolve(process.cwd(), argValue("db", "data/lpscan.sqlite"));
  const schemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
  const env = readEnv(path.resolve(process.cwd(), ".env"));
  const now = new Date().toISOString();

  ensureDatabase(dbPath, schemaPath);
  const syncRunId = createSyncRun(dbPath, owner, now);

  try {
    const result = await getOpenPositionsForWallet(owner, {
      heliusApiKey: env.HELIUS_API_KEY,
      birdeyeApiKeys: env.BIRD_EYE_API_KEY || env.BIRDEYE_API_KEY || "",
    });

    const statements = [];
    let eventCount = 0;

    for (const rawPosition of result.data.positions) {
      const position = await enrichPositionMetadata(rawPosition, env);
      statements.push(upsertPool(position, now));
      statements.push(upsertPosition(position, now));
      statements.push(upsertMetrics(position, syncRunId, now));

      for (const event of position.events) {
        eventCount += 1;
        statements.push(upsertEvent(position, event, syncRunId, now));
        for (const price of [event.price0, event.price1]) {
          const statement = upsertHistoricalPrice(price, now);
          if (statement) statements.push(statement);
        }
      }
    }

    runTransaction(dbPath, statements);
    finishSyncRun(
      dbPath,
      syncRunId,
      "success",
      new Date().toISOString(),
      { positionCount: result.data.positions.length, eventCount },
    );

    const summary = selectJson(
      dbPath,
      `
SELECT
  sr.id AS syncRunId,
  sr.owner,
  sr.position_count AS positionCount,
  sr.event_count AS eventCount,
  (SELECT COUNT(*) FROM position_events WHERE sync_run_id = sr.id AND reserve_delta_check_matches = 0) AS reserveDeltaMismatchCount
FROM sync_runs sr
WHERE sr.id = ${sqlInteger(syncRunId)};
`,
    )[0];

    console.log(JSON.stringify({ dbPath, ...summary }, null, 2));
  } catch (error) {
    finishSyncRun(
      dbPath,
      syncRunId,
      "failed",
      new Date().toISOString(),
      { positionCount: 0, eventCount: 0 },
      error.stack || error.message || String(error),
    );
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  readEnv,
  argValue,
  eventKey,
  priceKey,
  upsertPool,
  upsertPosition,
  upsertEvent,
  upsertHistoricalPrice,
  upsertMetrics,
  createSyncRun,
  finishSyncRun,
};
