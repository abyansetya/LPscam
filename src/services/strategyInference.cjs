function bnToString(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value.toString === "function") return value.toString();
  return String(value);
}

function bigintFrom(value) {
  const text = bnToString(value);
  if (!text) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

function formatRatio(upperLiquidity, lowerLiquidity) {
  if (lowerLiquidity === 0n && upperLiquidity === 0n) return null;
  if (lowerLiquidity === 0n) return Number.POSITIVE_INFINITY;
  const scale = 1_000_000n;
  return Number((upperLiquidity * scale) / lowerLiquidity) / Number(scale);
}

function confidenceForRatio(ratio) {
  if (ratio == null) return null;
  if (!Number.isFinite(ratio)) return 0.85;
  if (ratio >= 0.85 && ratio <= 1.15) return 0.7;
  if (ratio <= 0.5 || ratio >= 2) return 0.85;
  return 0.75;
}

function inferStrategyFromPositionBins(positionData, activeBinId, options = {}) {
  const lowerBinId = Number(positionData && positionData.lowerBinId);
  const upperBinId = Number(positionData && positionData.upperBinId);
  const active = Number(activeBinId);
  const bins = Array.isArray(positionData && positionData.positionBinData)
    ? positionData.positionBinData
    : [];

  if (!Number.isFinite(lowerBinId) || !Number.isFinite(upperBinId)) {
    return {
      inferredStrategyType: null,
      inferredStrategySource: "local_liquidity_distribution",
      inferredStrategyConfidence: null,
      inferredStrategyReason: "missing_range",
      inferredStrategyMetrics: null,
    };
  }

  if (!bins.length) {
    return {
      inferredStrategyType: null,
      inferredStrategySource: "local_liquidity_distribution",
      inferredStrategyConfidence: null,
      inferredStrategyReason: "missing_position_bins",
      inferredStrategyMetrics: null,
    };
  }

  const activeInRange = Number.isFinite(active) && active >= lowerBinId && active <= upperBinId;
  const splitBinId = activeInRange
    ? active
    : Math.floor((lowerBinId + upperBinId) / 2);
  const tolerance = options.tolerance ?? 0.15;
  const lowerMaxRatio = 1 - tolerance;
  const upperMinRatio = 1 + tolerance;

  let lowerLiquidity = 0n;
  let upperLiquidity = 0n;
  let lowerBinCount = 0;
  let upperBinCount = 0;
  let nonZeroBinCount = 0;

  for (const bin of bins) {
    const binId = Number(bin && bin.binId);
    if (!Number.isFinite(binId) || binId < lowerBinId || binId > upperBinId) continue;

    const liquidity = bigintFrom(bin.positionLiquidity);
    if (liquidity > 0n) nonZeroBinCount += 1;

    if (binId <= splitBinId) {
      lowerLiquidity += liquidity;
      lowerBinCount += 1;
    } else {
      upperLiquidity += liquidity;
      upperBinCount += 1;
    }
  }

  const ratio = formatRatio(upperLiquidity, lowerLiquidity);
  let inferredStrategyType = null;
  if (ratio != null) {
    if (ratio < lowerMaxRatio) inferredStrategyType = "BidAskImBalanced";
    else if (ratio <= upperMinRatio) inferredStrategyType = "Spot";
    else inferredStrategyType = "CurveImBalanced";
  }

  return {
    inferredStrategyType,
    inferredStrategySource: "local_liquidity_distribution",
    inferredStrategyConfidence: confidenceForRatio(ratio),
    inferredStrategyReason: inferredStrategyType ? null : "zero_liquidity_distribution",
    inferredStrategyMetrics: {
      lowerLiquidity: lowerLiquidity.toString(),
      upperLiquidity: upperLiquidity.toString(),
      liquidityRatio: ratio == null || !Number.isFinite(ratio) ? null : ratio,
      liquidityRatioLabel: ratio === Number.POSITIVE_INFINITY ? "infinity" : null,
      lowerBinCount,
      upperBinCount,
      nonZeroBinCount,
      splitBinId,
      splitSource: activeInRange ? "active_bin" : "range_midpoint",
      activeBinId: Number.isFinite(active) ? active : null,
      lowerBinId,
      upperBinId,
      tolerance,
    },
  };
}

module.exports = {
  inferStrategyFromPositionBins,
};
