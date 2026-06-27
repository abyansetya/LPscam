const path = require("path");

function loadDependency(name) {
  try {
    return require(name);
  } catch (localError) {
    const fallback = path.join("C:", "tmp", "lpagent-compare", "node_modules", name);
    try {
      return require(fallback);
    } catch {
      throw localError;
    }
  }
}

const { Connection, PublicKey } = loadDependency("@solana/web3.js");
const dlmmModule = loadDependency("@meteora-ag/dlmm");
const DLMM = dlmmModule.default || dlmmModule.DLMM || dlmmModule;
const { decodeDlmmEventsFromTransaction } = require("../shared/dlmmEventDecoder.cjs");
const { inferStrategyFromPositionBins } = require("../shared/strategyInference.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function rpc(rpcUrl, method, params) {
  return fetchJson(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function parseApiKeys(raw) {
  return (raw || "")
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function createKeyRing(keys) {
  let index = 0;
  return {
    size: keys.length,
    next() {
      if (!keys.length) return null;
      const key = keys[index % keys.length];
      index += 1;
      return key;
    },
  };
}

function bnToString(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value.toString === "function") return value.toString();
  return String(value);
}

function hexOrBnToNumber(value) {
  if (value == null) return 0;
  const stringValue = bnToString(value);
  if (!stringValue) return 0;
  if (/^[0-9a-f]+$/i.test(stringValue) && /[a-f]/i.test(stringValue)) {
    return Number.parseInt(stringValue, 16);
  }
  return Number(stringValue);
}

function adjustedAmount(rawAmount, decimals) {
  return Number(bnToString(rawAmount) || "0") / 10 ** Number(decimals || 0);
}

function positionLiquidity(positionData) {
  const bins = Array.isArray(positionData && positionData.positionBinData)
    ? positionData.positionBinData
    : [];
  const total = bins.reduce((sum, bin) => {
    try {
      return sum + BigInt(bnToString(bin.positionLiquidity) || "0");
    } catch {
      return sum;
    }
  }, 0n);
  return total.toString();
}

function binPriceUsd(bin, token1PriceUsd) {
  const pricePerToken = Number(bin && bin.pricePerToken);
  const quotePrice = Number(token1PriceUsd || 0);
  if (!Number.isFinite(pricePerToken) || !Number.isFinite(quotePrice)) return null;
  return pricePerToken * quotePrice;
}

function priceRangeFromBins(positionData, activeBinId, token1PriceUsd) {
  const bins = Array.isArray(positionData && positionData.positionBinData)
    ? positionData.positionBinData
    : [];
  const lowerBinId = Number(positionData && positionData.lowerBinId);
  const upperBinId = Number(positionData && positionData.upperBinId);
  const active = Number(activeBinId);
  const lower = bins.find((bin) => Number(bin.binId) === lowerBinId);
  const upper = bins.find((bin) => Number(bin.binId) === upperBinId);
  const activeBin = bins.find((bin) => Number(bin.binId) === active);
  const values = [lower, upper, activeBin].map((bin) => binPriceUsd(bin, token1PriceUsd));
  return values.every((value) => value != null) ? values : null;
}

function usdValue(amount0Raw, decimals0, price0, amount1Raw, decimals1, price1) {
  return (
    adjustedAmount(amount0Raw, decimals0) * Number(price0 || 0) +
    adjustedAmount(amount1Raw, decimals1) * Number(price1 || 0)
  );
}

function resolveDecimals(poolToken) {
  const decimals = Number(poolToken && poolToken.decimals);
  return Number.isFinite(decimals) ? decimals : 0;
}

function nearestHistoryPrice(items, timestamp) {
  if (!items || !items.length) return null;
  return items.reduce((nearest, item) => {
    if (!nearest) return item;
    const distance = Math.abs(Number(item.unixTime) - timestamp);
    const nearestDistance = Math.abs(Number(nearest.unixTime) - timestamp);
    return distance < nearestDistance ? item : nearest;
  }, null);
}

async function getBirdeyeHistoricalPrice(keyRing, tokenAddress, timestamp, cache) {
  if (!keyRing || !keyRing.size || !tokenAddress || !timestamp) return null;

  const roundedMinute = Math.floor(timestamp / 60) * 60;
  const cacheKey = `${tokenAddress}:${roundedMinute}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const from = timestamp - 300;
  const to = timestamp + 300;
  const url =
    `https://public-api.birdeye.so/defi/history_price?address=${tokenAddress}` +
    `&address_type=token&type=1m&time_from=${from}&time_to=${to}`;

  let response = null;
  const maxAttempts = Math.max(keyRing.size * 2, 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const apiKey = keyRing.next();
    await sleep(attempt === 1 ? 100 : 350);
    response = await fetchJson(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
        accept: "application/json",
      },
    }).catch((error) => ({
      success: false,
      error: error.message,
    }));

    if (!response.error || !response.error.includes("429")) break;
    if (attempt % keyRing.size === 0) await sleep(1000);
  }

  if (!response || !response.success || !response.data || !Array.isArray(response.data.items)) {
    const miss = {
      source: "birdeye",
      tokenAddress,
      timestamp,
      value: null,
      error: response && (response.error || response.message) || "Birdeye returned no data",
    };
    cache.set(cacheKey, miss);
    return miss;
  }

  const nearest = nearestHistoryPrice(response.data.items, timestamp);
  const result = nearest
    ? {
        source: "birdeye",
        tokenAddress,
        timestamp,
        value: Number(nearest.value),
        priceUnixTime: Number(nearest.unixTime),
        distanceSeconds: Math.abs(Number(nearest.unixTime) - timestamp),
      }
    : { source: "birdeye", tokenAddress, timestamp, value: null, error: "No price found" };

  cache.set(cacheKey, result);
  return result;
}

function tokenBalanceAmountByMint(balances, owner, mint) {
  const match = (balances || []).find((balance) => balance.owner === owner && balance.mint === mint);
  if (!match) return 0;
  return Number(match.uiTokenAmount && match.uiTokenAmount.amount ? match.uiTokenAmount.amount : 0);
}

function instructionNameFromLogs(logMessages) {
  const instructionLogs = (logMessages || [])
    .filter((line) => line.includes("Program log: Instruction:"))
    .map((line) => line.split("Program log: Instruction:")[1].trim());

  const priority = [
    "RebalanceLiquidity",
    "RemoveLiquidityByRange2",
    "RemoveLiquidity2",
    "RemoveLiquidity",
    "AddLiquidityByStrategy2",
    "AddLiquidityByStrategy",
    "AddLiquidity2",
    "AddLiquidity",
    "ClaimFee2",
    "ClaimReward2",
    "ClosePosition",
  ];

  return priority.find((name) => instructionLogs.includes(name)) || instructionLogs.at(-1) || null;
}

async function getPositionTransactions(rpcUrl, positionAddress) {
  const signaturesResponse = await rpc(rpcUrl, "getSignaturesForAddress", [
    positionAddress,
    { limit: 100 },
  ]);
  const signatures = (signaturesResponse.result || [])
    .filter((entry) => !entry.err)
    .map((entry) => entry.signature);

  const transactions = [];
  for (const signature of signatures) {
    const txResponse = await rpc(rpcUrl, "getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    if (txResponse.result) transactions.push(txResponse.result);
  }
  return transactions;
}

function derivePositionFlowFromTransaction(tx, poolAddress, token0, token1) {
  const pre0 = tokenBalanceAmountByMint(tx.meta && tx.meta.preTokenBalances, poolAddress, token0);
  const post0 = tokenBalanceAmountByMint(tx.meta && tx.meta.postTokenBalances, poolAddress, token0);
  const pre1 = tokenBalanceAmountByMint(tx.meta && tx.meta.preTokenBalances, poolAddress, token1);
  const post1 = tokenBalanceAmountByMint(tx.meta && tx.meta.postTokenBalances, poolAddress, token1);

  const delta0 = post0 - pre0;
  const delta1 = post1 - pre1;
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    blockTime: tx.blockTime,
    timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    instruction: instructionNameFromLogs(tx.meta && tx.meta.logMessages),
    poolDelta0: delta0,
    poolDelta1: delta1,
    input0: delta0 > 0 ? delta0 : 0,
    input1: delta1 > 0 ? delta1 : 0,
    output0: delta0 < 0 ? Math.abs(delta0) : 0,
    output1: delta1 < 0 ? Math.abs(delta1) : 0,
  };
}

function isForPosition(event, poolAddress, positionAddress) {
  const hasPool = Boolean(event.pool);
  const hasPosition = Boolean(event.position);
  if (!hasPool && !hasPosition) return false;
  if (hasPool && event.pool !== poolAddress) return false;
  if (hasPosition && event.position !== positionAddress) return false;
  return true;
}

function numberFromRaw(value) {
  return Number(bnToString(value) || "0");
}

function reserveDeltaMatches(reserveDeltaFlow, expected) {
  return (
    reserveDeltaFlow.input0 === expected.input0 &&
    reserveDeltaFlow.input1 === expected.input1 &&
    reserveDeltaFlow.output0 === expected.output0 &&
    reserveDeltaFlow.output1 === expected.output1
  );
}

function reserveDeltaCheck(reserveDeltaFlow, expected) {
  return {
    input0: reserveDeltaFlow.input0,
    input1: reserveDeltaFlow.input1,
    output0: reserveDeltaFlow.output0,
    output1: reserveDeltaFlow.output1,
    expected,
    matches: reserveDeltaMatches(reserveDeltaFlow, expected),
  };
}

function rebalanceDirection(event) {
  const rebalance = event.rebalance || {};
  const withdrawn0 = numberFromRaw(rebalance.withdrawn0Raw);
  const withdrawn1 = numberFromRaw(rebalance.withdrawn1Raw);
  const added0 = numberFromRaw(rebalance.added0Raw);
  const added1 = numberFromRaw(rebalance.added1Raw);
  const withdrawnTotal = withdrawn0 + withdrawn1;
  const addedTotal = added0 + added1;

  if (addedTotal && withdrawnTotal) return "rebalance_mixed";
  if (addedTotal) return "rebalance_increase";
  if (withdrawnTotal) return "rebalance_decrease";
  return "rebalance";
}

function flowFromDecodedEvent(event, reserveDeltaFlow, positionEvents) {
  const base = {
    signature: reserveDeltaFlow.signature,
    slot: reserveDeltaFlow.slot,
    blockTime: reserveDeltaFlow.blockTime,
    timestamp: reserveDeltaFlow.timestamp,
    instruction: reserveDeltaFlow.instruction,
    eventType: event.eventType,
    actionType: event.actionType,
    accountingSource: "dlmm_event_binary",
    poolDelta0: reserveDeltaFlow.poolDelta0,
    poolDelta1: reserveDeltaFlow.poolDelta1,
    decodedDlmmEvent: event,
    decodedDlmmEvents: positionEvents,
  };

  if (event.actionType === "liquidity_add" || event.actionType === "liquidity_remove") {
    const amount0 = numberFromRaw(event.amount0Raw);
    const amount1 = numberFromRaw(event.amount1Raw);
    const isAdd = event.actionType === "liquidity_add";
    const expected = {
      input0: isAdd ? amount0 : 0,
      input1: isAdd ? amount1 : 0,
      output0: isAdd ? 0 : amount0,
      output1: isAdd ? 0 : amount1,
    };

    return {
      ...base,
      ...expected,
      reserveDeltaCheck: reserveDeltaCheck(reserveDeltaFlow, expected),
    };
  }

  if (event.actionType === "rebalance") {
    const rebalance = event.rebalance || {};
    const expected = {
      input0: numberFromRaw(rebalance.added0Raw),
      input1: numberFromRaw(rebalance.added1Raw),
      output0: numberFromRaw(rebalance.withdrawn0Raw),
      output1: numberFromRaw(rebalance.withdrawn1Raw),
    };

    return {
      ...base,
      ...expected,
      actionType: rebalanceDirection(event),
      claimedFee0Raw: event.claimedFee0Raw,
      claimedFee1Raw: event.claimedFee1Raw,
      reserveDeltaCheck: reserveDeltaCheck(reserveDeltaFlow, expected),
    };
  }

  if (event.actionType === "claim_fee") {
    return {
      ...base,
      input0: 0,
      input1: 0,
      output0: 0,
      output1: 0,
      claimedFee0Raw: event.claimedFee0Raw,
      claimedFee1Raw: event.claimedFee1Raw,
      reserveDeltaCheck: reserveDeltaCheck(reserveDeltaFlow, {
        input0: 0,
        input1: 0,
        output0: numberFromRaw(event.claimedFee0Raw),
        output1: numberFromRaw(event.claimedFee1Raw),
      }),
    };
  }

  if (event.actionType === "claim_reward") {
    return {
      ...base,
      input0: 0,
      input1: 0,
      output0: 0,
      output1: 0,
      claimedRewardRaw: event.claimedRewardRaw,
      rewardIndex: event.rewardIndex,
    };
  }

  return {
    ...base,
    input0: 0,
    input1: 0,
    output0: 0,
    output1: 0,
  };
}

function derivePositionFlowsFromTransaction(tx, poolAddress, positionAddress, token0, token1) {
  const reserveDeltaFlow = derivePositionFlowFromTransaction(tx, poolAddress, token0, token1);
  const decodedEvents = decodeDlmmEventsFromTransaction(tx);
  const positionEvents = decodedEvents.filter((event) => isForPosition(event, poolAddress, positionAddress));
  const accountingEvents = positionEvents.filter((event) =>
    [
      "liquidity_add",
      "liquidity_remove",
      "rebalance",
      "claim_fee",
      "claim_reward",
      "position_create",
      "position_close",
    ].includes(event.actionType),
  );

  if (!accountingEvents.length) {
    return [
      {
        ...reserveDeltaFlow,
        accountingSource: "reserve_delta",
        decodedDlmmEvents: positionEvents,
      },
    ];
  }

  return accountingEvents.map((event) =>
    flowFromDecodedEvent(event, reserveDeltaFlow, positionEvents),
  );
}

async function summarizeEventAccounting(flows, pricing) {
  const events = [];
  const totals = {
    input0: 0,
    input1: 0,
    output0: 0,
    output1: 0,
    inputValueUsd: 0,
    outputValueUsd: 0,
  };

  const auditFlows = flows.filter(
    (entry) =>
      entry.input0 ||
      entry.input1 ||
      entry.output0 ||
      entry.output1 ||
      entry.accountingSource === "dlmm_event_binary",
  );

  for (const flow of auditFlows) {
    const hasTokenAccounting = Boolean(flow.input0 || flow.input1 || flow.output0 || flow.output1);
    const price0 = hasTokenAccounting
      ? await getBirdeyeHistoricalPrice(
          pricing.birdeyeKeyRing,
          pricing.token0,
          flow.blockTime,
          pricing.priceCache,
        )
      : null;
    const price1 = hasTokenAccounting
      ? await getBirdeyeHistoricalPrice(
          pricing.birdeyeKeyRing,
          pricing.token1,
          flow.blockTime,
          pricing.priceCache,
        )
      : null;

    const inputValueUsd = usdValue(
      flow.input0,
      pricing.decimal0,
      price0 && price0.value,
      flow.input1,
      pricing.decimal1,
      price1 && price1.value,
    );
    const outputValueUsd = usdValue(
      flow.output0,
      pricing.decimal0,
      price0 && price0.value,
      flow.output1,
      pricing.decimal1,
      price1 && price1.value,
    );

    totals.input0 += flow.input0;
    totals.input1 += flow.input1;
    totals.output0 += flow.output0;
    totals.output1 += flow.output1;
    totals.inputValueUsd += inputValueUsd;
    totals.outputValueUsd += outputValueUsd;

    events.push({
      ...flow,
      price0,
      price1,
      inputValueUsd,
      outputValueUsd,
    });
  }

  return { totals, events };
}

async function getAccountSummary(rpcUrl, address) {
  const response = await rpc(rpcUrl, "getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const value = response.result && response.result.value;
  if (!value) return null;
  return {
    ownerProgram: value.owner,
    lamports: value.lamports,
    dataLength: Buffer.from(value.data[0], "base64").length,
  };
}

function matchedPublicKey(decoded) {
  const positions = decoded.poolData.lbPairPositionsData || [];
  const matched = positions.find((entry) => entry.positionData === decoded.positionData);
  return matched && matched.publicKey;
}

async function getOpenPositionSnapshotsForWallet(owner, config) {
  const heliusApiKey = config.heliusApiKey;
  if (!heliusApiKey) throw new Error("Missing HELIUS_API_KEY");

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
  const connection = new Connection(rpcUrl, "confirmed");

  const decodedMap = await DLMM.getAllLbPairPositionsByUser(
    connection,
    new PublicKey(owner),
    { cluster: "mainnet-beta" },
    { chunkSize: 50, isParallelExecution: true },
  );

  const positions = [];
  for (const [, poolData] of decodedMap.entries()) {
    const poolAddress = String(poolData.publicKey);
    const poolMeta = await fetchJson(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`);
    const token0 = String(poolData.lbPair && poolData.lbPair.tokenXMint);
    const token1 = String(poolData.lbPair && poolData.lbPair.tokenYMint);
    const decimal0 = resolveDecimals(poolMeta.token_x);
    const decimal1 = resolveDecimals(poolMeta.token_y);
    const activeBinId = Number(bnToString(poolData.lbPair && poolData.lbPair.activeId));

    for (const entry of poolData.lbPairPositionsData || []) {
      const positionData = entry.positionData;
      const position = String(entry.publicKey || matchedPublicKey({ poolData, positionData }));
      const lowerBinId = Number(positionData.lowerBinId);
      const upperBinId = Number(positionData.upperBinId);
      const inRange = activeBinId >= lowerBinId && activeBinId <= upperBinId;
      const total0Raw = bnToString(positionData.totalXAmount);
      const total1Raw = bnToString(positionData.totalYAmount);
      const fee0Raw = hexOrBnToNumber(positionData.feeX);
      const fee1Raw = hexOrBnToNumber(positionData.feeY);
      const currentValueUsd = usdValue(
        total0Raw,
        decimal0,
        poolMeta.token_x && poolMeta.token_x.price,
        total1Raw,
        decimal1,
        poolMeta.token_y && poolMeta.token_y.price,
      );
      const unclaimedFeeUsd = usdValue(
        fee0Raw,
        decimal0,
        poolMeta.token_x && poolMeta.token_x.price,
        fee1Raw,
        decimal1,
        poolMeta.token_y && poolMeta.token_y.price,
      );
      const inferredStrategy = inferStrategyFromPositionBins(positionData, activeBinId);
      const bins = Array.isArray(positionData.positionBinData) ? positionData.positionBinData : [];

      positions.push({
        status: "Open",
        owner,
        position,
        pool: poolAddress,
        pairName: poolMeta.name || null,
        protocol: "meteora",
        token0: {
          mint: token0,
          symbol: poolMeta.token_x && poolMeta.token_x.symbol,
          decimals: decimal0,
          priceUsd: poolMeta.token_x && poolMeta.token_x.price,
        },
        token1: {
          mint: token1,
          symbol: poolMeta.token_y && poolMeta.token_y.symbol,
          decimals: decimal1,
          priceUsd: poolMeta.token_y && poolMeta.token_y.price,
        },
        range: {
          lowerBinId,
          upperBinId,
          activeBinId,
          inRange,
        },
        priceRange: priceRangeFromBins(
          positionData,
          activeBinId,
          poolMeta.token_y && poolMeta.token_y.price,
        ),
        current: {
          amount0Raw: total0Raw,
          amount1Raw: total1Raw,
          amount0: adjustedAmount(total0Raw, decimal0),
          amount1: adjustedAmount(total1Raw, decimal1),
          valueUsd: currentValueUsd,
        },
        fees: {
          unclaimedFee0Raw: String(fee0Raw),
          unclaimedFee1Raw: String(fee1Raw),
          unclaimedFee0: adjustedAmount(fee0Raw, decimal0),
          unclaimedFee1: adjustedAmount(fee1Raw, decimal1),
          unclaimedFeeUsd,
        },
        liquidity: positionLiquidity(positionData),
        bins,
        poolInfo: {
          fee: poolMeta.pool_config && poolMeta.pool_config.base_fee_pct,
          tickSpacing: poolMeta.pool_config && poolMeta.pool_config.bin_step,
        },
        apr: poolMeta.apr == null ? null : Number(poolMeta.apr),
        yield24h:
          poolMeta.fee_tvl_ratio && poolMeta.fee_tvl_ratio["24h"] != null
            ? Number(poolMeta.fee_tvl_ratio["24h"])
            : null,
        sources: {
          position: "helius_rpc_meteora_dlmm_sdk",
          poolMeta: "meteora_datapi",
          inferredStrategyType: inferredStrategy.inferredStrategyType,
          inferredStrategySource: inferredStrategy.inferredStrategySource,
          inferredStrategyConfidence: inferredStrategy.inferredStrategyConfidence,
          inferredStrategyReason: inferredStrategy.inferredStrategyReason,
          inferredStrategyMetrics: inferredStrategy.inferredStrategyMetrics,
        },
        updatedAt: new Date(hexOrBnToNumber(positionData.lastUpdatedAt) * 1000).toISOString(),
      });
    }
  }

  return {
    status: "success",
    data: {
      owner,
      count: positions.length,
      positions,
      syncedAt: new Date().toISOString(),
    },
  };
}

async function getOpenPositionsForWallet(owner, config) {
  const heliusApiKey = config.heliusApiKey;
  if (!heliusApiKey) throw new Error("Missing HELIUS_API_KEY");

  const birdeyeKeys = parseApiKeys(config.birdeyeApiKeys);
  const birdeyeKeyRing = createKeyRing(birdeyeKeys);
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
  const connection = new Connection(rpcUrl, "confirmed");

  const decodedMap = await DLMM.getAllLbPairPositionsByUser(
    connection,
    new PublicKey(owner),
    { cluster: "mainnet-beta" },
    { chunkSize: 50, isParallelExecution: true },
  );

  const positions = [];
  for (const [, poolData] of decodedMap.entries()) {
    const poolAddress = String(poolData.publicKey);
    const poolMeta = await fetchJson(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`);
    const token0 = String(poolData.lbPair && poolData.lbPair.tokenXMint);
    const token1 = String(poolData.lbPair && poolData.lbPair.tokenYMint);
    const decimal0 = resolveDecimals(poolMeta.token_x);
    const decimal1 = resolveDecimals(poolMeta.token_y);
    const activeBinId = Number(bnToString(poolData.lbPair && poolData.lbPair.activeId));

    for (const entry of poolData.lbPairPositionsData || []) {
      const positionData = entry.positionData;
      const position = String(entry.publicKey || matchedPublicKey({ poolData, positionData }));
      const lowerBinId = Number(positionData.lowerBinId);
      const upperBinId = Number(positionData.upperBinId);
      const inRange = activeBinId >= lowerBinId && activeBinId <= upperBinId;

      const total0Raw = bnToString(positionData.totalXAmount);
      const total1Raw = bnToString(positionData.totalYAmount);
      const fee0Raw = hexOrBnToNumber(positionData.feeX);
      const fee1Raw = hexOrBnToNumber(positionData.feeY);

      const currentValueUsd = usdValue(
        total0Raw,
        decimal0,
        poolMeta.token_x && poolMeta.token_x.price,
        total1Raw,
        decimal1,
        poolMeta.token_y && poolMeta.token_y.price,
      );
      const unclaimedFeeUsd = usdValue(
        fee0Raw,
        decimal0,
        poolMeta.token_x && poolMeta.token_x.price,
        fee1Raw,
        decimal1,
        poolMeta.token_y && poolMeta.token_y.price,
      );

      const transactions = await getPositionTransactions(rpcUrl, position);
      const flows = transactions.flatMap((tx) =>
        derivePositionFlowsFromTransaction(tx, poolAddress, position, token0, token1),
      );
      const eventAccounting = await summarizeEventAccounting(flows, {
        birdeyeKeyRing,
        priceCache: new Map(),
        token0,
        token1,
        decimal0,
        decimal1,
      });

      const inputValueUsd = eventAccounting.totals.inputValueUsd;
      const outputValueUsd = eventAccounting.totals.outputValueUsd;
      const collectedFeeUsd = 0;
      const pnlUsd =
        outputValueUsd + collectedFeeUsd + unclaimedFeeUsd + currentValueUsd - inputValueUsd;
      const pnlPercent = inputValueUsd > 0 ? (pnlUsd / inputValueUsd) * 100 : null;
      const inferredStrategy = inferStrategyFromPositionBins(positionData, activeBinId);
      const bins = Array.isArray(positionData.positionBinData) ? positionData.positionBinData : [];

      positions.push({
        status: "Open",
        owner,
        position,
        pool: poolAddress,
        pairName: poolMeta.name || null,
        protocol: "meteora",
        token0: {
          mint: token0,
          symbol: poolMeta.token_x && poolMeta.token_x.symbol,
          decimals: decimal0,
          priceUsd: poolMeta.token_x && poolMeta.token_x.price,
        },
        token1: {
          mint: token1,
          symbol: poolMeta.token_y && poolMeta.token_y.symbol,
          decimals: decimal1,
          priceUsd: poolMeta.token_y && poolMeta.token_y.price,
        },
        range: {
          lowerBinId,
          upperBinId,
          activeBinId,
          inRange,
        },
        priceRange: priceRangeFromBins(
          positionData,
          activeBinId,
          poolMeta.token_y && poolMeta.token_y.price,
        ),
        current: {
          amount0Raw: total0Raw,
          amount1Raw: total1Raw,
          amount0: adjustedAmount(total0Raw, decimal0),
          amount1: adjustedAmount(total1Raw, decimal1),
          valueUsd: currentValueUsd,
        },
        fees: {
          unclaimedFee0Raw: String(fee0Raw),
          unclaimedFee1Raw: String(fee1Raw),
          unclaimedFee0: adjustedAmount(fee0Raw, decimal0),
          unclaimedFee1: adjustedAmount(fee1Raw, decimal1),
          unclaimedFeeUsd,
          collectedFeeUsd,
        },
        liquidity: positionLiquidity(positionData),
        bins,
        poolInfo: {
          fee: poolMeta.pool_config && poolMeta.pool_config.base_fee_pct,
          tickSpacing: poolMeta.pool_config && poolMeta.pool_config.bin_step,
        },
        apr: poolMeta.apr == null ? null : Number(poolMeta.apr),
        yield24h:
          poolMeta.fee_tvl_ratio && poolMeta.fee_tvl_ratio["24h"] != null
            ? Number(poolMeta.fee_tvl_ratio["24h"])
            : null,
        accounting: {
          input0Raw: String(eventAccounting.totals.input0),
          input1Raw: String(eventAccounting.totals.input1),
          output0Raw: String(eventAccounting.totals.output0),
          output1Raw: String(eventAccounting.totals.output1),
          inputValueUsd,
          outputValueUsd,
          currentValueUsd,
          unclaimedFeeUsd,
          collectedFeeUsd,
          pnlUsd,
          pnlPercent,
        },
        events: eventAccounting.events,
        account: await getAccountSummary(rpcUrl, position),
        sources: {
          position: "helius_rpc_meteora_dlmm_sdk",
          poolMeta: "meteora_datapi",
          events: "helius_getTransaction_dlmm_event_binary_with_reserve_delta_fallback",
          historicalPrice: birdeyeKeys.length ? "birdeye_history_price" : "missing_birdeye_key",
          inferredStrategyType: inferredStrategy.inferredStrategyType,
          inferredStrategySource: inferredStrategy.inferredStrategySource,
          inferredStrategyConfidence: inferredStrategy.inferredStrategyConfidence,
          inferredStrategyReason: inferredStrategy.inferredStrategyReason,
          inferredStrategyMetrics: inferredStrategy.inferredStrategyMetrics,
        },
        updatedAt: new Date(hexOrBnToNumber(positionData.lastUpdatedAt) * 1000).toISOString(),
      });
    }
  }

  return {
    status: "success",
    data: {
      owner,
      count: positions.length,
      positions,
      syncedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  getOpenPositionSnapshotsForWallet,
  getOpenPositionsForWallet,
};
