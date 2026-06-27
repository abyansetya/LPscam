const path = require("path");
const { selectJson, sqlText } = require("../db/sqliteCli.cjs");

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function adjusted(rawAmount, decimals) {
  return Number(rawAmount || "0") / 10 ** Number(decimals || 0);
}

function pairDisplayName(pairName) {
  return pairName ? pairName.replace("-", "/") : null;
}

function isoAgeHours(createdAt) {
  if (!createdAt) return null;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ageMs)) return null;
  return Math.max(ageMs / 36e5, 0);
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventFromRow(row) {
  return {
    signature: row.signature,
    slot: row.slot,
    blockTime: row.block_time,
    timestamp: row.timestamp,
    instruction: row.instruction,
    eventType: row.event_type,
    actionType: row.action_type,
    accountingSource: row.accounting_source,
    amount0Raw: row.amount0_raw,
    amount1Raw: row.amount1_raw,
    input0Raw: row.input0_raw,
    input1Raw: row.input1_raw,
    output0Raw: row.output0_raw,
    output1Raw: row.output1_raw,
    poolDelta0Raw: row.pool_delta0_raw,
    poolDelta1Raw: row.pool_delta1_raw,
    activeBinId: row.active_bin_id,
    oldLowerBinId: row.old_lower_bin_id,
    oldUpperBinId: row.old_upper_bin_id,
    newLowerBinId: row.new_lower_bin_id,
    newUpperBinId: row.new_upper_bin_id,
    claimedFee0Raw: row.claimed_fee0_raw,
    claimedFee1Raw: row.claimed_fee1_raw,
    claimedRewardRaw: row.claimed_reward_raw,
    rewardIndex: row.reward_index,
    reserveDeltaCheckMatches:
      row.reserve_delta_check_matches == null ? null : Boolean(row.reserve_delta_check_matches),
    reserveDeltaCheck: parseJson(row.reserve_delta_check_json),
    decodedEvent: parseJson(row.decoded_event_json),
    price0: parseJson(row.price0_json),
    price1: parseJson(row.price1_json),
    inputValueUsd: row.input_value_usd,
    outputValueUsd: row.output_value_usd,
  };
}

function getPositionDetailFromSqlite(positionAddress, options = {}) {
  const dbPath = path.resolve(options.dbPath || path.join(process.cwd(), "data/lpscan.sqlite"));
  const rows = selectJson(
    dbPath,
    `
SELECT
  p.*,
  pools.pair_name,
  pools.token0_mint,
  pools.token0_symbol,
  pools.token0_decimals,
  pools.token1_mint,
  pools.token1_symbol,
  pools.token1_decimals,
  m.input0_raw AS metric_input0_raw,
  m.input1_raw AS metric_input1_raw,
  m.output0_raw AS metric_output0_raw,
  m.output1_raw AS metric_output1_raw,
  m.input_value_usd,
  m.output_value_usd,
  m.current_value_usd,
  m.unclaimed_fee_usd,
  m.collected_fee_usd,
  m.pnl_usd,
  m.pnl_percent,
  m.event_count
FROM positions p
JOIN pools ON pools.pool_address = p.pool_address
LEFT JOIN position_metrics m ON m.position_address = p.position_address
WHERE p.position_address = ${sqlText(positionAddress)}
LIMIT 1;
`,
  );

  if (!rows.length) {
    return {
      status: "error",
      message: "Position not found in SQLite. Ingest the owner or position history first.",
    };
  }

  const row = rows[0];
  const eventRows = selectJson(
    dbPath,
    `
SELECT *
FROM position_events
WHERE position_address = ${sqlText(positionAddress)}
ORDER BY block_time ASC, outer_instruction_index ASC, inner_instruction_index ASC, event_type ASC;
`,
  );
  const events = eventRows.map(eventFromRow);
  const latestPricedEvent = events
    .slice()
    .reverse()
    .find((event) => event.price0 || event.price1);
  const collectedFeeNative = events
    .filter((event) => event.actionType === "claim_fee" && event.outputValueUsd && event.price1 && event.price1.value)
    .reduce((sum, event) => sum + Number(event.outputValueUsd) / Number(event.price1.value), 0);
  const createdAt = events.find((event) => event.actionType === "position_create")?.timestamp ||
    events[0]?.timestamp ||
    null;
  const ageHour = isoAgeHours(createdAt);
  const amount0Adjusted = adjusted(row.current_amount0_raw, row.token0_decimals);
  const amount1Adjusted = adjusted(row.current_amount1_raw, row.token1_decimals);
  const inputNative = row.token1_mint === "So11111111111111111111111111111111111111112"
    ? adjusted(row.metric_input1_raw, row.token1_decimals)
    : null;
  const outputNative = row.token1_mint === "So11111111111111111111111111111111111111112"
    ? adjusted(row.metric_output1_raw, row.token1_decimals)
    : null;
  const currentNative = row.token1_mint === "So11111111111111111111111111111111111111112"
    ? amount1Adjusted
    : null;

  const unresolvedFields = [
    "strategyType",
    "impermanentLoss",
    "dpr",
    "dprNative",
    "yield24h",
    "apr",
    "poolInfo.fee",
    "poolInfo.tickSpacing",
    "priceRange",
    "bins",
  ];

  return {
    status: "success",
    data: {
      status: row.status,
      strategyType: null,
      tokenId: row.position_address,
      pairName: pairDisplayName(row.pair_name),
      currentValue: row.current_value_usd == null ? null : String(row.current_value_usd),
      inputValue: row.input_value_usd,
      inputNative,
      outputValue: row.output_value_usd,
      outputNative,
      collectedReward: 0,
      collectedRewardNative: 0,
      collectedFee: row.collected_fee_usd,
      collectedFeeNative,
      uncollectedFee: row.unclaimed_fee_usd == null ? null : String(row.unclaimed_fee_usd),
      impermanentLoss: null,
      inputToken0: row.metric_input0_raw,
      inputToken1: row.metric_input1_raw,
      tickLower: row.lower_bin_id,
      tickUpper: row.upper_bin_id,
      pool: row.pool_address,
      liquidity: null,
      token0: row.token0_mint,
      token1: row.token1_mint,
      inRange: row.in_range == null ? null : Boolean(row.in_range),
      createdAt,
      updatedAt: row.onchain_updated_at || row.synced_at,
      pnl: {
        value: row.pnl_usd,
        percent: row.pnl_percent,
        valueNative:
          latestPricedEvent && latestPricedEvent.price1 && latestPricedEvent.price1.value
            ? row.pnl_usd / latestPricedEvent.price1.value
            : null,
        percentNative: null,
      },
      pnlNative:
        latestPricedEvent && latestPricedEvent.price1 && latestPricedEvent.price1.value
          ? row.pnl_usd / latestPricedEvent.price1.value
          : null,
      upnl: null,
      owner: row.owner,
      dpr: null,
      dprNative: null,
      ageHour,
      decimal0: row.token0_decimals,
      decimal1: row.token1_decimals,
      yield24h: null,
      apr: null,
      protocol: row.protocol,
      token0Info: {
        token_symbol: row.token0_symbol,
        token_name: row.token0_symbol,
        token_decimals: row.token0_decimals,
        token_address: row.token0_mint,
        logo: null,
      },
      token1Info: {
        token_symbol: row.token1_symbol,
        token_name: row.token1_symbol,
        token_decimals: row.token1_decimals,
        token_address: row.token1_mint,
        logo:
          row.token1_mint === "So11111111111111111111111111111111111111112"
            ? "https://www.dextools.io/resources/tokens/logos/3/solana/So11111111111111111111111111111111111111112.jpg"
            : null,
      },
      poolInfo: {
        fee: null,
        tickSpacing: null,
      },
      age: ageHour == null ? null : (ageHour / 24).toFixed(2),
      position: row.position_address,
      logo0: row.token0_mint
        ? `https://token-logo.getnimbus.io/api/v1/logo?address=${row.token0_mint}&chain=SOL`
        : null,
      logo1: row.token1_mint
        ? `https://token-logo.getnimbus.io/api/v1/logo?address=${row.token1_mint}&chain=SOL`
        : null,
      tokenName0: row.token0_symbol,
      tokenName1: row.token1_symbol,
      priceRange: null,
      range: [row.lower_bin_id, row.upper_bin_id, row.active_bin_id],
      value: row.current_value_usd,
      valueNative: currentNative,
      current: {
        amount0: row.current_amount0_raw,
        amount1: row.current_amount1_raw,
        amount0Adjusted,
        amount1Adjusted,
      },
      unCollectedFee0: adjusted(row.unclaimed_fee0_raw, row.token0_decimals),
      unCollectedFee1: adjusted(row.unclaimed_fee1_raw, row.token1_decimals),
      unCollectedFee: row.unclaimed_fee_usd,
      unCollectedFeeNative: null,
      price0: latestPricedEvent && latestPricedEvent.price0 ? latestPricedEvent.price0.value : null,
      price1: latestPricedEvent && latestPricedEvent.price1 ? latestPricedEvent.price1.value : null,
      bins: null,
      events,
      sources: {
        detail: "sqlite_position_events",
        unresolvedFields,
        account: parseJson(row.account_json),
        rawSources: parseJson(row.sources_json, {}),
      },
    },
  };
}

function getPositionLogsFromSqlite(positionAddress, options = {}) {
  const dbPath = path.resolve(options.dbPath || path.join(process.cwd(), "data/lpscan.sqlite"));
  const eventRows = selectJson(
    dbPath,
    `
SELECT *
FROM position_events
WHERE position_address = ${sqlText(positionAddress)}
ORDER BY block_time ASC, outer_instruction_index ASC, inner_instruction_index ASC, event_type ASC;
`,
  );

  if (!eventRows.length) {
    return {
      status: "error",
      message: "Position logs not found in SQLite. Ingest the owner or position first.",
    };
  }

  return {
    status: "success",
    count: eventRows.length,
    data: eventRows.map(eventFromRow),
  };
}

function getWalletOpenPositionsFromSqlite(owner, options = {}) {
  const dbPath = path.resolve(options.dbPath || path.join(process.cwd(), "data/lpscan.sqlite"));
  const syncRows = selectJson(
    dbPath,
    `
SELECT started_at, finished_at
FROM sync_runs
WHERE owner = ${sqlText(owner)}
  AND status = 'success'
ORDER BY id DESC
LIMIT 1;
`,
  );
  const latestSync = syncRows[0] || null;
  const freshFilter = latestSync
    ? `AND p.synced_at >= ${sqlText(latestSync.started_at)}`
    : "";
  const rows = selectJson(
    dbPath,
    `
SELECT p.position_address
FROM positions p
WHERE p.owner = ${sqlText(owner)}
  AND p.status = 'Open'
  ${freshFilter}
ORDER BY synced_at DESC, position_address ASC;
`,
  );

  const positions = rows
    .map((row) => getPositionDetailFromSqlite(row.position_address, { dbPath }))
    .filter((payload) => payload.status === "success")
    .map((payload) => {
      const { events, sources, ...position } = payload.data;
      return {
        ...position,
        sources: {
          detail: sources.detail,
          unresolvedFields: sources.unresolvedFields,
        },
      };
    });

  return {
    status: "success",
    source: "sqlite_index",
    syncedAt: latestSync && latestSync.finished_at,
    syncStartedAt: latestSync && latestSync.started_at,
    stalenessSeconds:
      latestSync && latestSync.finished_at
        ? Math.max((Date.now() - new Date(latestSync.finished_at).getTime()) / 1000, 0)
        : null,
    count: positions.length,
    data: positions,
  };
}

module.exports = {
  getPositionDetailFromSqlite,
  getPositionLogsFromSqlite,
  getWalletOpenPositionsFromSqlite,
};
