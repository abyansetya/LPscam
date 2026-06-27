const path = require("path");
const { getOpenPositionSnapshotsForWallet } = require("../onchain/onchainOpenPositions.cjs");
const {
  getWalletOpenPositionsFromSqlite,
  getWalletPositionsFromSqlite,
} = require("./sqlitePositionDetails.cjs");

const SOL_MINT = "So11111111111111111111111111111111111111112";

function pairDisplayName(pairName) {
  return pairName ? pairName.replace("-", "/") : null;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  return value == null ? null : String(value);
}

function nativeFromUsd(usdValue, nativePriceUsd) {
  const usd = numberOrNull(usdValue);
  const price = numberOrNull(nativePriceUsd);
  if (usd == null || !price || price <= 0) return null;
  return usd / price;
}

function pnlFromHybrid(sqlitePosition, livePosition) {
  const inputValue = numberOrNull(sqlitePosition.inputValue);
  if (!inputValue || inputValue <= 0) return sqlitePosition.pnl || null;

  const outputValue = numberOrNull(sqlitePosition.outputValue) || 0;
  const collectedFee = numberOrNull(sqlitePosition.collectedFee) || 0;
  const currentValue = numberOrNull(livePosition.current && livePosition.current.valueUsd) || 0;
  const unclaimedFee = numberOrNull(livePosition.fees && livePosition.fees.unclaimedFeeUsd) || 0;
  const currentValueNative = nativeFromUsd(currentValue, livePosition.token1 && livePosition.token1.priceUsd);
  const unclaimedFeeNative = nativeFromUsd(unclaimedFee, livePosition.token1 && livePosition.token1.priceUsd);
  const outputNative = numberOrNull(sqlitePosition.outputNative) || 0;
  const collectedFeeNative = numberOrNull(sqlitePosition.collectedFeeNative) || 0;
  const inputNative = numberOrNull(sqlitePosition.inputNative);
  const valueNative =
    inputNative == null || currentValueNative == null || unclaimedFeeNative == null
      ? nativeFromUsd(
          outputValue + collectedFee + currentValue + unclaimedFee - inputValue,
          livePosition.token1 && livePosition.token1.priceUsd,
        )
      : outputNative + collectedFeeNative + currentValueNative + unclaimedFeeNative - inputNative;
  const value = outputValue + collectedFee + currentValue + unclaimedFee - inputValue;

  return {
    ...(sqlitePosition.pnl || {}),
    value,
    percent: (value / inputValue) * 100,
    valueNative,
    percentNative:
      inputNative
        ? (valueNative / inputNative) * 100
        : null,
  };
}

function liveOnlyPosition(livePosition) {
  const token0 = livePosition.token0 || {};
  const token1 = livePosition.token1 || {};
  const current = livePosition.current || {};
  const fees = livePosition.fees || {};
  const range = livePosition.range || {};
  const valueNative = nativeFromUsd(current.valueUsd, token1.priceUsd);
  const unCollectedFeeNative = nativeFromUsd(fees.unclaimedFeeUsd, token1.priceUsd);

  return {
    status: "Open",
    strategyType: livePosition.sources && livePosition.sources.inferredStrategyType || null,
    inferredStrategyType: livePosition.sources && livePosition.sources.inferredStrategyType,
    inferredStrategySource: livePosition.sources && livePosition.sources.inferredStrategySource,
    inferredStrategyConfidence: livePosition.sources && livePosition.sources.inferredStrategyConfidence,
    inferredStrategyReason: livePosition.sources && livePosition.sources.inferredStrategyReason,
    inferredStrategyMetrics: livePosition.sources && livePosition.sources.inferredStrategyMetrics,
    tokenId: livePosition.position,
    pairName: pairDisplayName(livePosition.pairName),
    currentValue: stringOrNull(current.valueUsd),
    inputValue: null,
    inputNative: null,
    outputValue: null,
    outputNative: null,
    collectedReward: 0,
    collectedRewardNative: 0,
    collectedFee: 0,
    collectedFeeNative: 0,
    uncollectedFee: stringOrNull(fees.unclaimedFeeUsd),
    impermanentLoss: null,
    inputToken0: null,
    inputToken1: null,
    tickLower: range.lowerBinId,
    tickUpper: range.upperBinId,
    pool: livePosition.pool,
    liquidity: livePosition.liquidity || null,
    token0: token0.mint,
    token1: token1.mint,
    inRange: range.inRange,
    createdAt: null,
    updatedAt: livePosition.updatedAt,
    pnl: null,
    pnlNative: null,
    upnl: null,
    owner: livePosition.owner,
    dpr: null,
    dprNative: null,
    ageHour: null,
    decimal0: token0.decimals,
    decimal1: token1.decimals,
    yield24h: livePosition.yield24h,
    apr: livePosition.apr,
    protocol: livePosition.protocol,
    token0Info: {
      token_symbol: token0.symbol,
      token_name: token0.symbol,
      token_decimals: token0.decimals,
      token_address: token0.mint,
      logo: null,
    },
    token1Info: {
      token_symbol: token1.symbol,
      token_name: token1.symbol,
      token_decimals: token1.decimals,
      token_address: token1.mint,
      logo:
        token1.mint === SOL_MINT
          ? "https://www.dextools.io/resources/tokens/logos/3/solana/So11111111111111111111111111111111111111112.jpg"
          : null,
    },
    poolInfo: livePosition.poolInfo || {
      fee: null,
      tickSpacing: null,
    },
    age: null,
    position: livePosition.position,
    logo0: token0.mint
      ? `https://token-logo.getnimbus.io/api/v1/logo?address=${token0.mint}&chain=SOL`
      : null,
    logo1: token1.mint
      ? `https://token-logo.getnimbus.io/api/v1/logo?address=${token1.mint}&chain=SOL`
      : null,
    tokenName0: token0.symbol,
    tokenName1: token1.symbol,
    priceRange: livePosition.priceRange || null,
    range: [range.lowerBinId, range.upperBinId, range.activeBinId],
    value: current.valueUsd,
    valueNative,
    current: {
      amount0: current.amount0Raw,
      amount1: current.amount1Raw,
      amount0Adjusted: current.amount0,
      amount1Adjusted: current.amount1,
    },
    unCollectedFee0: fees.unclaimedFee0,
    unCollectedFee1: fees.unclaimedFee1,
    unCollectedFee: fees.unclaimedFeeUsd,
    unCollectedFeeNative,
    price0: token0.priceUsd,
    price1: token1.priceUsd,
    bins: livePosition.bins || null,
    sources: {
      detail: "onchain_snapshot",
      unresolvedFields: ["history", "metrics"],
      current: "onchain",
      history: "missing_sqlite",
    },
  };
}

function mergePosition(sqlitePosition, livePosition) {
  if (!sqlitePosition) return liveOnlyPosition(livePosition);

  const token0 = livePosition.token0 || {};
  const token1 = livePosition.token1 || {};
  const current = livePosition.current || {};
  const fees = livePosition.fees || {};
  const range = livePosition.range || {};
  const valueNative = nativeFromUsd(current.valueUsd, token1.priceUsd);
  const unCollectedFeeNative = nativeFromUsd(fees.unclaimedFeeUsd, token1.priceUsd);
  const pnl = pnlFromHybrid(sqlitePosition, livePosition);

  return {
    ...sqlitePosition,
    status: "Open",
    strategyType:
      sqlitePosition.strategyType ||
      (livePosition.sources && livePosition.sources.inferredStrategyType) ||
      null,
    inferredStrategyType:
      (livePosition.sources && livePosition.sources.inferredStrategyType) ||
      sqlitePosition.inferredStrategyType,
    inferredStrategySource:
      (livePosition.sources && livePosition.sources.inferredStrategySource) ||
      sqlitePosition.inferredStrategySource,
    inferredStrategyConfidence:
      (livePosition.sources && livePosition.sources.inferredStrategyConfidence) ||
      sqlitePosition.inferredStrategyConfidence,
    inferredStrategyReason:
      (livePosition.sources && livePosition.sources.inferredStrategyReason) ||
      sqlitePosition.inferredStrategyReason,
    inferredStrategyMetrics:
      (livePosition.sources && livePosition.sources.inferredStrategyMetrics) ||
      sqlitePosition.inferredStrategyMetrics,
    pairName: pairDisplayName(livePosition.pairName) || sqlitePosition.pairName,
    currentValue: current.valueUsd == null ? sqlitePosition.currentValue : String(current.valueUsd),
    uncollectedFee:
      fees.unclaimedFeeUsd == null ? sqlitePosition.uncollectedFee : String(fees.unclaimedFeeUsd),
    tickLower: range.lowerBinId,
    tickUpper: range.upperBinId,
    pool: livePosition.pool,
    liquidity: livePosition.liquidity || sqlitePosition.liquidity,
    token0: token0.mint,
    token1: token1.mint,
    inRange: range.inRange,
    updatedAt: livePosition.updatedAt || sqlitePosition.updatedAt,
    pnl,
    pnlNative: pnl && pnl.valueNative,
    owner: livePosition.owner,
    decimal0: token0.decimals,
    decimal1: token1.decimals,
    protocol: livePosition.protocol || sqlitePosition.protocol,
    yield24h: livePosition.yield24h == null ? sqlitePosition.yield24h : livePosition.yield24h,
    apr: livePosition.apr == null ? sqlitePosition.apr : livePosition.apr,
    token0Info: {
      ...(sqlitePosition.token0Info || {}),
      token_symbol: token0.symbol,
      token_name: token0.symbol,
      token_decimals: token0.decimals,
      token_address: token0.mint,
    },
    token1Info: {
      ...(sqlitePosition.token1Info || {}),
      token_symbol: token1.symbol,
      token_name: token1.symbol,
      token_decimals: token1.decimals,
      token_address: token1.mint,
    },
    poolInfo: livePosition.poolInfo || sqlitePosition.poolInfo,
    priceRange: livePosition.priceRange || sqlitePosition.priceRange,
    range: [range.lowerBinId, range.upperBinId, range.activeBinId],
    value: current.valueUsd,
    valueNative,
    current: {
      amount0: current.amount0Raw,
      amount1: current.amount1Raw,
      amount0Adjusted: current.amount0,
      amount1Adjusted: current.amount1,
    },
    unCollectedFee0: fees.unclaimedFee0,
    unCollectedFee1: fees.unclaimedFee1,
    unCollectedFee: fees.unclaimedFeeUsd,
    unCollectedFeeNative,
    price0: token0.priceUsd,
    price1: token1.priceUsd,
    bins: livePosition.bins || sqlitePosition.bins,
    sources: {
      ...(sqlitePosition.sources || {}),
      current: "onchain",
      history: "sqlite",
      metrics: "sqlite_with_onchain_current_overlay",
      rawLiveSources: livePosition.sources,
    },
  };
}

async function getWalletOpenPositionsHybrid(owner, config) {
  const dbPath = path.resolve(config.dbPath || path.join(process.cwd(), "data/lpscan.sqlite"));
  const sqlitePayload = getWalletPositionsFromSqlite(owner, { dbPath });

  try {
    const livePayload = await getOpenPositionSnapshotsForWallet(owner, config);
    const sqliteByPosition = new Map(
      (sqlitePayload.data || []).map((position) => [position.position, position]),
    );
    const positions = livePayload.data.positions.map((position) =>
      mergePosition(sqliteByPosition.get(position.position), position),
    );

    return {
      status: "success",
      source: "hybrid_onchain_sqlite",
      syncedAt: livePayload.data.syncedAt,
      sqliteSyncedAt: sqlitePayload.syncedAt,
      sqliteStalenessSeconds: sqlitePayload.stalenessSeconds,
      count: positions.length,
      data: positions,
    };
  } catch (error) {
    const fallbackPayload = getWalletOpenPositionsFromSqlite(owner, { dbPath });
    return {
      ...fallbackPayload,
      source: "sqlite_fallback_after_onchain_error",
      stale: true,
      onchainError: error.message,
    };
  }
}

module.exports = {
  mergePosition,
  getWalletOpenPositionsHybrid,
};
