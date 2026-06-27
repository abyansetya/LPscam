const path = require("path");
const { decodeDlmmEventsFromTransaction } = require("../shared/dlmmEventDecoder.cjs");

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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchLpagentLogs(lpagentKey, owner, positionAddress) {
  if (!lpagentKey || !owner || !positionAddress) return [];

  const url =
    `https://api.lpagent.io/open-api/v1/lp-positions/logs?owner=${encodeURIComponent(owner)}` +
    `&position=${encodeURIComponent(positionAddress)}`;
  const payload = await fetchJson(url, {
    headers: {
      "x-api-key": lpagentKey,
      accept: "application/json",
    },
  }).catch(() => null);

  return payload && Array.isArray(payload.data) ? payload.data : [];
}

function lpagentLogActionForEvent(event) {
  if (event.actionType === "liquidity_add" || event.actionType === "rebalance_increase") {
    return "increase";
  }
  if (event.actionType === "liquidity_remove" || event.actionType === "rebalance_decrease") {
    return "decrease";
  }
  if (event.actionType === "claim_fee") return "collectFee";
  return null;
}

function buildLpagentLogMap(logs) {
  const map = new Map();
  for (const log of logs || []) {
    if (!log || !log.txHash) continue;
    const key = [log.txHash, log.action || ""].join(":");
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(log);
  }
  return map;
}

function findLpagentLogForEvent(logMap, event, expected) {
  const action = lpagentLogActionForEvent(event);
  if (!action) return null;

  const candidates = logMap.get([event.signature, action].join(":")) || [];
  if (!candidates.length) return null;

  const amount0 = String(
    action === "increase" ? expected.input0 : expected.output0 || event.claimedFee0Raw || 0,
  );
  const amount1 = String(
    action === "increase" ? expected.input1 : expected.output1 || event.claimedFee1Raw || 0,
  );

  return candidates.find((log) => String(log.amount0 || "0") === amount0 && String(log.amount1 || "0") === amount1) ||
    candidates[0];
}

function priceFromLpagentLog(log, tokenAddress, tokenIndex) {
  if (!log || !tokenAddress) return null;
  const value = Number(tokenIndex === 0 ? log.price0 : log.price1);
  if (!Number.isFinite(value)) return null;

  const timestamp = log.timestamp ? Math.floor(new Date(log.timestamp).getTime() / 1000) : null;
  return {
    source: "lpagent_open_api_logs",
    tokenAddress,
    timestamp,
    value,
    priceUnixTime: timestamp,
    distanceSeconds: 0,
  };
}

function latestLogWithRange(logs) {
  return (logs || [])
    .filter((log) => log && log.tickLower != null && log.tickUpper != null)
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())[0] || null;
}

async function rpc(rpcUrl, method, params) {
  return fetchJson(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function tokenBalanceAmountByMint(balances, owner, mint) {
  const match = (balances || []).find((balance) => balance.owner === owner && balance.mint === mint);
  if (!match) return 0;
  return Number(match.uiTokenAmount && balanceAmount(match));
}

function balanceAmount(balance) {
  return balance.uiTokenAmount && balance.uiTokenAmount.amount ? balance.uiTokenAmount.amount : 0;
}

function instructionNameFromLogs(logMessages) {
  const instructionLogs = (logMessages || [])
    .filter((line) => line.includes("Program log: Instruction:"))
    .map((line) => line.split("Program log: Instruction:")[1].trim());

  const priority = [
    "ClosePosition",
    "ClaimFee2",
    "ClaimFee",
    "ClaimReward2",
    "ClaimReward",
    "RebalanceLiquidity",
    "RemoveLiquidityByRange2",
    "RemoveLiquidity2",
    "RemoveLiquidity",
    "AddLiquidityByStrategy2",
    "AddLiquidityByStrategy",
    "AddLiquidity2",
    "AddLiquidity",
    "InitializePosition2",
    "InitializePosition",
  ];

  return priority.find((name) => instructionLogs.includes(name)) || instructionLogs.at(-1) || null;
}

function numberFromRaw(value) {
  return Number(value || "0");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function adjustedAmount(rawAmount, decimals) {
  return Number(rawAmount || "0") / 10 ** Number(decimals || 0);
}

function usdValue(amount0Raw, decimals0, price0, amount1Raw, decimals1, price1) {
  return (
    adjustedAmount(amount0Raw, decimals0) * Number(price0 || 0) +
    adjustedAmount(amount1Raw, decimals1) * Number(price1 || 0)
  );
}

function derivePoolDeltas(tx, poolAddress, token0, token1) {
  const pre0 = tokenBalanceAmountByMint(tx.meta && tx.meta.preTokenBalances, poolAddress, token0);
  const post0 = tokenBalanceAmountByMint(tx.meta && tx.meta.postTokenBalances, poolAddress, token0);
  const pre1 = tokenBalanceAmountByMint(tx.meta && tx.meta.preTokenBalances, poolAddress, token1);
  const post1 = tokenBalanceAmountByMint(tx.meta && tx.meta.postTokenBalances, poolAddress, token1);
  return {
    poolDelta0: post0 - pre0,
    poolDelta1: post1 - pre1,
  };
}

function reserveDeltaFlow(tx, poolAddress, token0, token1) {
  const { poolDelta0, poolDelta1 } = derivePoolDeltas(tx, poolAddress, token0, token1);
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    blockTime: tx.blockTime,
    timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    instruction: instructionNameFromLogs(tx.meta && tx.meta.logMessages),
    poolDelta0,
    poolDelta1,
    input0: poolDelta0 > 0 ? poolDelta0 : 0,
    input1: poolDelta1 > 0 ? poolDelta1 : 0,
    output0: poolDelta0 < 0 ? Math.abs(poolDelta0) : 0,
    output1: poolDelta1 < 0 ? Math.abs(poolDelta1) : 0,
  };
}

function hasPreferredClaimFeeEvent(event, group) {
  if (event.eventType !== "ClaimFee") return false;
  return group.some(
    (entry) =>
      entry.eventType === "ClaimFee2" &&
      entry.claimedFee0Raw === event.claimedFee0Raw &&
      entry.claimedFee1Raw === event.claimedFee1Raw,
  );
}

function expectedAmounts(event, group = []) {
  if (event.actionType === "liquidity_add") {
    return {
      input0: numberFromRaw(event.amount0Raw),
      input1: numberFromRaw(event.amount1Raw),
      output0: 0,
      output1: 0,
    };
  }
  if (event.actionType === "liquidity_remove") {
    return {
      input0: 0,
      input1: 0,
      output0: numberFromRaw(event.amount0Raw),
      output1: numberFromRaw(event.amount1Raw),
    };
  }
  if (event.actionType === "rebalance") {
    const rebalance = event.rebalance || {};
    return {
      input0: numberFromRaw(rebalance.added0Raw),
      input1: numberFromRaw(rebalance.added1Raw),
      output0: numberFromRaw(rebalance.withdrawn0Raw),
      output1: numberFromRaw(rebalance.withdrawn1Raw),
    };
  }
  if (event.actionType === "claim_fee" && !hasPreferredClaimFeeEvent(event, group)) {
    return {
      input0: 0,
      input1: 0,
      output0: numberFromRaw(event.claimedFee0Raw),
      output1: numberFromRaw(event.claimedFee1Raw),
    };
  }
  return {
    input0: 0,
    input1: 0,
    output0: 0,
    output1: 0,
  };
}

function reserveDeltaCheck(flow, expected) {
  return {
    input0: flow.input0,
    input1: flow.input1,
    output0: flow.output0,
    output1: flow.output1,
    expected,
    matches:
      flow.input0 === expected.input0 &&
      flow.input1 === expected.input1 &&
      flow.output0 === expected.output0 &&
      flow.output1 === expected.output1,
  };
}

function rebalanceDirection(event, expected) {
  const withdrawnTotal = expected.output0 + expected.output1;
  const addedTotal = expected.input0 + expected.input1;
  if (addedTotal && withdrawnTotal) return "rebalance_mixed";
  if (addedTotal) return "rebalance_increase";
  if (withdrawnTotal) return "rebalance_decrease";
  return event.actionType;
}

async function getPoolMeta(poolAddress) {
  return fetchJson(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`).catch(() => null);
}

async function scanPositionHistory(positionAddress, config) {
  const heliusApiKey = config.heliusApiKey;
  if (!heliusApiKey) throw new Error("Missing HELIUS_API_KEY");

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
  const connection = new Connection(rpcUrl, "confirmed");
  const accountInfo = await connection.getAccountInfo(new PublicKey(positionAddress));
  const account = accountInfo
    ? {
        ownerProgram: accountInfo.owner.toBase58(),
        lamports: accountInfo.lamports,
        dataLength: accountInfo.data.length,
      }
    : null;

  const signaturesResponse = await rpc(rpcUrl, "getSignaturesForAddress", [
    positionAddress,
    { limit: config.limit || 100 },
  ]);
  const signatures = (signaturesResponse.result || []).filter((entry) => !entry.err);
  const transactions = [];
  for (const signature of signatures.map((entry) => entry.signature)) {
    const txResponse = await rpc(rpcUrl, "getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    if (txResponse.result) transactions.push(txResponse.result);
  }

  const decodedEvents = transactions.flatMap((tx) =>
    decodeDlmmEventsFromTransaction(tx).filter((event) => event.position === positionAddress),
  );
  const firstPool = decodedEvents.find((event) => event.pool)?.pool || null;
  const owner = decodedEvents.find((event) => event.owner)?.owner || null;
  const poolMeta = firstPool ? await getPoolMeta(firstPool) : null;
  const token0 = poolMeta && poolMeta.token_x && poolMeta.token_x.address;
  const token1 = poolMeta && poolMeta.token_y && poolMeta.token_y.address;
  const decimal0 = Number(poolMeta && poolMeta.token_x && poolMeta.token_x.decimals) || 0;
  const decimal1 = Number(poolMeta && poolMeta.token_y && poolMeta.token_y.decimals) || 0;
  const lpagentLogs = await fetchLpagentLogs(config.lpagentKey, owner, positionAddress);
  const lpagentLogMap = buildLpagentLogMap(lpagentLogs);
  const lpagentRangeLog = latestLogWithRange(lpagentLogs);
  const lpagentStrategyLog = lpagentLogs.find((log) => log && log.strategyType);
  const birdeyeKeyRing = createKeyRing(parseApiKeys(config.birdeyeApiKeys));
  const priceCache = new Map();
  const eventGroups = new Map();

  for (const event of decodedEvents) {
    if (!eventGroups.has(event.signature)) eventGroups.set(event.signature, []);
    eventGroups.get(event.signature).push(event);
  }

  const events = [];
  for (const tx of transactions) {
    const flow = token0 && token1 && firstPool
      ? reserveDeltaFlow(tx, firstPool, token0, token1)
      : {
          signature: tx.transaction.signatures[0],
          slot: tx.slot,
          blockTime: tx.blockTime,
          timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
          instruction: instructionNameFromLogs(tx.meta && tx.meta.logMessages),
          poolDelta0: 0,
          poolDelta1: 0,
          input0: 0,
          input1: 0,
          output0: 0,
          output1: 0,
        };
    const group = eventGroups.get(flow.signature) || [];
    for (const event of group) {
      const expected = expectedAmounts(event, group);
      const actionType = event.actionType === "rebalance" ? rebalanceDirection(event, expected) : event.actionType;
      const hasReserveCheck = ["liquidity_add", "liquidity_remove", "rebalance", "claim_fee"].includes(event.actionType) &&
        Boolean(expected.input0 || expected.input1 || expected.output0 || expected.output1);
      const hasTokenAccounting = Boolean(expected.input0 || expected.input1 || expected.output0 || expected.output1);
      const lpagentLog = findLpagentLogForEvent(lpagentLogMap, { ...event, actionType, signature: flow.signature }, expected);
      const lpagentPrice0 = priceFromLpagentLog(lpagentLog, token0, 0);
      const lpagentPrice1 = priceFromLpagentLog(lpagentLog, token1, 1);
      const price0 = lpagentPrice0 || (hasTokenAccounting
        ? await getBirdeyeHistoricalPrice(birdeyeKeyRing, token0, flow.blockTime, priceCache)
        : null);
      const price1 = lpagentPrice1 || (hasTokenAccounting
        ? await getBirdeyeHistoricalPrice(birdeyeKeyRing, token1, flow.blockTime, priceCache)
        : null);
      const inputValueUsd = usdValue(
        expected.input0,
        decimal0,
        price0 && price0.value,
        expected.input1,
        decimal1,
        price1 && price1.value,
      );
      const outputValueUsd = usdValue(
        expected.output0,
        decimal0,
        price0 && price0.value,
        expected.output1,
        decimal1,
        price1 && price1.value,
      );

      events.push({
        ...flow,
        eventType: event.eventType,
        actionType,
        accountingSource: "dlmm_event_binary",
        input0: expected.input0,
        input1: expected.input1,
        output0: expected.output0,
        output1: expected.output1,
        claimedFee0Raw: event.claimedFee0Raw,
        claimedFee1Raw: event.claimedFee1Raw,
        claimedRewardRaw: event.claimedRewardRaw,
        rewardIndex: event.rewardIndex,
        reserveDeltaCheck: hasReserveCheck ? reserveDeltaCheck(flow, expected) : null,
        decodedDlmmEvent: event,
        decodedDlmmEvents: group,
        lpagentLog: lpagentLog || null,
        price0,
        price1,
        inputValueUsd,
        outputValueUsd,
      });
    }
  }

  events.sort((a, b) =>
    (a.blockTime || 0) - (b.blockTime || 0) ||
    ((a.decodedDlmmEvent && a.decodedDlmmEvent.outerInstructionIndex) || 0) -
      ((b.decodedDlmmEvent && b.decodedDlmmEvent.outerInstructionIndex) || 0) ||
    ((a.decodedDlmmEvent && a.decodedDlmmEvent.innerInstructionIndex) || 0) -
      ((b.decodedDlmmEvent && b.decodedDlmmEvent.innerInstructionIndex) || 0),
  );

  const status = events.some((event) => event.actionType === "position_close")
    ? "Closed"
    : accountInfo ? "Open" : "Historical";
  const nonFeeEvents = events.filter((event) => event.actionType !== "claim_fee");
  const feeEvents = events.filter((event) => event.actionType === "claim_fee");
  const input0Raw = nonFeeEvents.reduce((sum, event) => sum + Number(event.input0 || 0), 0);
  const input1Raw = nonFeeEvents.reduce((sum, event) => sum + Number(event.input1 || 0), 0);
  const output0Raw = nonFeeEvents.reduce((sum, event) => sum + Number(event.output0 || 0), 0);
  const output1Raw = nonFeeEvents.reduce((sum, event) => sum + Number(event.output1 || 0), 0);
  const inputValueUsd = nonFeeEvents.reduce((sum, event) => sum + Number(event.inputValueUsd || 0), 0);
  const outputValueUsd = nonFeeEvents.reduce((sum, event) => sum + Number(event.outputValueUsd || 0), 0);
  const collectedFeeUsd = feeEvents.reduce((sum, event) => sum + Number(event.outputValueUsd || 0), 0);
  const pnlUsd = outputValueUsd + collectedFeeUsd - inputValueUsd;
  const pnlPercent = inputValueUsd > 0 ? (pnlUsd / inputValueUsd) * 100 : null;

  return {
    status,
    owner,
    position: positionAddress,
    pool: firstPool,
    pairName: poolMeta && poolMeta.name,
    protocol: "meteora",
    token0: {
      mint: token0 || null,
      symbol: poolMeta && poolMeta.token_x && poolMeta.token_x.symbol,
      decimals: decimal0,
      priceUsd: poolMeta && poolMeta.token_x && poolMeta.token_x.price,
    },
    token1: {
      mint: token1 || null,
      symbol: poolMeta && poolMeta.token_y && poolMeta.token_y.symbol,
      decimals: decimal1,
      priceUsd: poolMeta && poolMeta.token_y && poolMeta.token_y.price,
    },
    range: {
      lowerBinId: lpagentRangeLog ? Number(lpagentRangeLog.tickLower) : null,
      upperBinId: lpagentRangeLog ? Number(lpagentRangeLog.tickUpper) : null,
      activeBinId: null,
      inRange: null,
    },
    current: {
      amount0Raw: "0",
      amount1Raw: "0",
      amount0: 0,
      amount1: 0,
      valueUsd: 0,
    },
    fees: {
      unclaimedFee0Raw: "0",
      unclaimedFee1Raw: "0",
      unclaimedFee0: 0,
      unclaimedFee1: 0,
      unclaimedFeeUsd: 0,
      collectedFeeUsd,
    },
    accounting: {
      input0Raw: String(input0Raw),
      input1Raw: String(input1Raw),
      output0Raw: String(output0Raw),
      output1Raw: String(output1Raw),
      inputValueUsd,
      outputValueUsd,
      currentValueUsd: 0,
      unclaimedFeeUsd: 0,
      collectedFeeUsd,
      pnlUsd,
      pnlPercent,
    },
    events,
    account,
    sources: {
      position: "helius_rpc_getSignaturesForAddress_position",
      poolMeta: poolMeta ? "meteora_datapi" : "missing_pool_meta",
      events: "helius_getTransaction_dlmm_event_binary",
      historicalPrice: lpagentLogs.length
        ? "lpagent_open_api_logs_with_birdeye_fallback"
        : birdeyeKeyRing.size ? "birdeye_history_price" : "missing_birdeye_key",
      strategyType: lpagentStrategyLog ? lpagentStrategyLog.strategyType : null,
      strategyTypeSource: lpagentStrategyLog ? "lpagent_open_api_logs" : null,
      rangeSource: lpagentRangeLog ? "lpagent_open_api_logs" : null,
    },
    updatedAt: events.at(-1)?.timestamp || new Date().toISOString(),
  };
}

module.exports = {
  scanPositionHistory,
};
