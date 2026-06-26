const fs = require("fs");
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

const DEFAULT_OWNER = "Hsr6xL4XPbAkkseYYSDXfCzgLsnKA9QUqqPMxPSiWzA8";
const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

function readEnv(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const env = {};

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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} failed ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(connectionUrl, method, params) {
  return fetchJson(connectionUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
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
  if (value == null) return null;
  const stringValue = bnToString(value);
  if (!stringValue) return null;

  if (/^[0-9a-f]+$/i.test(stringValue) && /[a-f]/i.test(stringValue)) {
    return Number.parseInt(stringValue, 16);
  }

  return Number(stringValue);
}

function adjustedAmount(rawAmount, decimals) {
  return Number(bnToString(rawAmount) || "0") / 10 ** Number(decimals);
}

function resolveDecimals(lpDecimal, poolToken) {
  if (lpDecimal !== null && lpDecimal !== undefined && lpDecimal !== "") {
    const parsed = Number(lpDecimal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const fallback = Number(poolToken && poolToken.decimals);
  return Number.isFinite(fallback) ? fallback : 0;
}

function usdValue(amount0Raw, decimals0, price0, amount1Raw, decimals1, price1) {
  return (
    adjustedAmount(amount0Raw, decimals0) * Number(price0 || 0) +
    adjustedAmount(amount1Raw, decimals1) * Number(price1 || 0)
  );
}

function closeEnough(a, b, epsilon = 1e-6) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= epsilon;
}

function getBirdeyeApiKeys(env) {
  return (env.BIRD_EYE_API_KEY || env.BIRDEYE_API_KEY || "")
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function createBirdeyeKeyRing(keys) {
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

function nearestHistoryPrice(items, timestamp) {
  if (!items || !items.length) return null;

  return items.reduce((nearest, item) => {
    if (!nearest) return item;
    const currentDistance = Math.abs(Number(item.unixTime) - timestamp);
    const nearestDistance = Math.abs(Number(nearest.unixTime) - timestamp);
    return currentDistance < nearestDistance ? item : nearest;
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
    await sleep(attempt === 1 ? 250 : 500);
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
    if (attempt % keyRing.size === 0) await sleep(1500);
  }

  if (!response.success || !response.data || !Array.isArray(response.data.items)) {
    const miss = {
      tokenAddress,
      timestamp,
      source: "birdeye",
      value: null,
      error: response.error || response.message || "Birdeye history_price returned no items",
    };
    cache.set(cacheKey, miss);
    return miss;
  }

  const nearest = nearestHistoryPrice(response.data.items, timestamp);
  const result = nearest
    ? {
        tokenAddress,
        timestamp,
        source: "birdeye",
        value: Number(nearest.value),
        priceUnixTime: Number(nearest.unixTime),
        distanceSeconds: Math.abs(Number(nearest.unixTime) - timestamp),
      }
    : {
        tokenAddress,
        timestamp,
        source: "birdeye",
        value: null,
        error: "No nearest price found",
      };

  cache.set(cacheKey, result);
  return result;
}

function nearestPreviousCandle(items, timestamp) {
  if (!items || !items.length) return null;

  const previous = items
    .filter((item) => Number(item.timestamp) <= timestamp)
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];

  if (previous) return previous;

  return items
    .slice()
    .sort(
      (a, b) =>
        Math.abs(Number(a.timestamp) - timestamp) - Math.abs(Number(b.timestamp) - timestamp),
    )[0];
}

async function getMeteoraPoolOhlcvPrice(poolAddress, timestamp, cache) {
  if (!poolAddress || !timestamp) return null;

  const bucket = Math.floor(timestamp / 300) * 300;
  const cacheKey = `${poolAddress}:${bucket}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const start = timestamp - 900;
  const end = timestamp + 900;
  const url =
    `https://dlmm.datapi.meteora.ag/pools/${poolAddress}/ohlcv` +
    `?timeframe=5m&start_time=${start}&end_time=${end}`;

  const response = await fetchJson(url).catch((error) => ({
    error: error.message,
  }));

  if (!response || response.error || !Array.isArray(response.data)) {
    const miss = {
      poolAddress,
      timestamp,
      source: "meteora_ohlcv",
      value: null,
      error: response && (response.error || response.message) || "Meteora OHLCV returned no data",
    };
    cache.set(cacheKey, miss);
    return miss;
  }

  const candle = nearestPreviousCandle(response.data, timestamp);
  const result = candle
    ? {
        poolAddress,
        timestamp,
        source: "meteora_ohlcv",
        timeframe: response.timeframe,
        value: Number(candle.close),
        candle: {
          timestamp: Number(candle.timestamp),
          timestampStr: candle.timestamp_str,
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume),
        },
        distanceSeconds: timestamp - Number(candle.timestamp),
      }
    : {
        poolAddress,
        timestamp,
        source: "meteora_ohlcv",
        value: null,
        error: "No candle found",
      };

  cache.set(cacheKey, result);
  return result;
}

function summarizeLpPosition(position) {
  return {
    status: position.status,
    position: position.position || position.tokenId || position.id,
    pool: position.pool,
    owner: position.owner,
    pairName: position.pairName,
    token0: position.token0,
    token1: position.token1,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    range: position.range,
    inRange: position.inRange,
    current: position.current,
    price0: position.price0,
    price1: position.price1,
    value: Number(position.value),
    currentValue: Number(position.currentValue),
    unCollectedFee: Number(position.unCollectedFee ?? position.uncollectedFee),
    inputValue: Number(position.inputValue),
    outputValue: Number(position.outputValue),
    collectedFee: Number(position.collectedFee),
    pnl: position.pnl,
    createdAt: position.createdAt,
    updatedAt: position.updatedAt,
  };
}

function findDecodedPosition(decodedMap, poolAddress, positionAddress) {
  const poolData = decodedMap.get(poolAddress);
  if (!poolData) return null;

  const positions = poolData.lbPairPositionsData || [];
  const matched = positions.find((entry) => String(entry.publicKey) === positionAddress);
  if (!matched) return null;

  return {
    poolData,
    positionData: matched.positionData,
    version: matched.version,
  };
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

function tokenBalanceAmountByMint(balances, owner, mint) {
  const match = (balances || []).find(
    (balance) => balance.owner === owner && balance.mint === mint,
  );
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
    "InitializePosition2",
    "InitializePosition",
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
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
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
  const input0 = delta0 > 0 ? delta0 : 0;
  const input1 = delta1 > 0 ? delta1 : 0;
  const output0 = delta0 < 0 ? Math.abs(delta0) : 0;
  const output1 = delta1 < 0 ? Math.abs(delta1) : 0;

  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    blockTime: tx.blockTime,
    timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    instruction: instructionNameFromLogs(tx.meta && tx.meta.logMessages),
    poolDelta0: delta0,
    poolDelta1: delta1,
    input0,
    input1,
    output0,
    output1,
  };
}

async function getLpagentLogs(lpagentKey, owner, position) {
  const url = `https://api.lpagent.io/open-api/v1/lp-positions/logs?owner=${owner}&position=${position}`;
  const response = await fetchJson(url, {
    headers: { "x-api-key": lpagentKey },
  });

  return response.data || [];
}

function lpagentPriceBySignature(logs) {
  const map = new Map();
  for (const log of logs) {
    map.set(log.txHash, {
      action: log.action,
      price0: Number(log.price0),
      price1: Number(log.price1),
      nativePrice: Number(log.nativePrice),
      tickLower: log.tickLower,
      tickUpper: log.tickUpper,
    });
  }
  return map;
}

async function summarizeFlows(flows, priceMap, decimals0, decimals1, pricing) {
  const enriched = [];

  for (const flow of flows.filter(
    (entry) => entry.input0 || entry.input1 || entry.output0 || entry.output1,
  )) {
    const prices = priceMap.get(flow.signature) || {};
    const lpagentLogInputUsd = usdValue(
      flow.input0,
      decimals0,
      prices.price0,
      flow.input1,
      decimals1,
      prices.price1,
    );
    const lpagentLogOutputUsd = usdValue(
      flow.output0,
      decimals0,
      prices.price0,
      flow.output1,
      decimals1,
      prices.price1,
    );

    let birdeyePrice0 = null;
    let birdeyePrice1 = null;
    let meteoraPoolPrice = null;
    if (pricing && pricing.birdeyeKeyRing && flow.blockTime) {
      birdeyePrice0 = await getBirdeyeHistoricalPrice(
        pricing.birdeyeKeyRing,
        pricing.token0,
        flow.blockTime,
        pricing.birdeyeCache,
      );
      birdeyePrice1 = await getBirdeyeHistoricalPrice(
        pricing.birdeyeKeyRing,
        pricing.token1,
        flow.blockTime,
        pricing.birdeyeCache,
      );
    }
    if (pricing && pricing.poolAddress && flow.blockTime) {
      meteoraPoolPrice = await getMeteoraPoolOhlcvPrice(
        pricing.poolAddress,
        flow.blockTime,
        pricing.meteoraOhlcvCache,
      );
    }

    const birdeyeInputUsd = usdValue(
      flow.input0,
      decimals0,
      birdeyePrice0 && birdeyePrice0.value,
      flow.input1,
      decimals1,
      birdeyePrice1 && birdeyePrice1.value,
    );
    const birdeyeOutputUsd = usdValue(
      flow.output0,
      decimals0,
      birdeyePrice0 && birdeyePrice0.value,
      flow.output1,
      decimals1,
      birdeyePrice1 && birdeyePrice1.value,
    );
    const meteoraPoolToken0Usd =
      meteoraPoolPrice && meteoraPoolPrice.value && birdeyePrice1 && birdeyePrice1.value
        ? meteoraPoolPrice.value * birdeyePrice1.value
        : null;
    const meteoraPoolInputUsd = usdValue(
      flow.input0,
      decimals0,
      meteoraPoolToken0Usd,
      flow.input1,
      decimals1,
      birdeyePrice1 && birdeyePrice1.value,
    );
    const meteoraPoolOutputUsd = usdValue(
      flow.output0,
      decimals0,
      meteoraPoolToken0Usd,
      flow.output1,
      decimals1,
      birdeyePrice1 && birdeyePrice1.value,
    );

    enriched.push({
      ...flow,
      lpagentLog: prices.action
        ? {
            action: prices.action,
            price0: prices.price0,
            price1: prices.price1,
            nativePrice: prices.nativePrice,
            tickLower: prices.tickLower,
            tickUpper: prices.tickUpper,
          }
        : null,
      lpagentLogInputUsd,
      lpagentLogOutputUsd,
      birdeye: {
        price0: birdeyePrice0,
        price1: birdeyePrice1,
        inputUsd: birdeyeInputUsd,
        outputUsd: birdeyeOutputUsd,
      },
      meteoraPoolOhlcv: {
        poolPriceToken0InToken1: meteoraPoolPrice,
        token0Usd: meteoraPoolToken0Usd,
        token1Usd: birdeyePrice1,
        inputUsd: meteoraPoolInputUsd,
        outputUsd: meteoraPoolOutputUsd,
      },
    });
  }

  return {
    flows: enriched,
    totals: enriched.reduce(
      (totals, flow) => {
        totals.input0 += flow.input0;
        totals.input1 += flow.input1;
        totals.output0 += flow.output0;
        totals.output1 += flow.output1;
        totals.lpagentLogInputUsd += flow.lpagentLogInputUsd;
        totals.lpagentLogOutputUsd += flow.lpagentLogOutputUsd;
        totals.birdeyeInputUsd += flow.birdeye.inputUsd;
        totals.birdeyeOutputUsd += flow.birdeye.outputUsd;
        totals.meteoraPoolInputUsd += flow.meteoraPoolOhlcv.inputUsd;
        totals.meteoraPoolOutputUsd += flow.meteoraPoolOhlcv.outputUsd;
        return totals;
      },
      {
        input0: 0,
        input1: 0,
        output0: 0,
        output1: 0,
        lpagentLogInputUsd: 0,
        lpagentLogOutputUsd: 0,
        birdeyeInputUsd: 0,
        birdeyeOutputUsd: 0,
        meteoraPoolInputUsd: 0,
        meteoraPoolOutputUsd: 0,
      },
    ),
  };
}

async function main() {
  const owner = process.argv[2] || DEFAULT_OWNER;
  const envPath = path.resolve(process.cwd(), ".env");
  const env = readEnv(envPath);

  const lpagentKey = env.VITE_LPAGENT_API_KEY || env.LPAGENT_API_KEY;
  const heliusKey = env.HELIUS_API_KEY;
  const birdeyeKeys = getBirdeyeApiKeys(env);
  const birdeyeKeyRing = createBirdeyeKeyRing(birdeyeKeys);

  if (!lpagentKey) throw new Error("Missing VITE_LPAGENT_API_KEY or LPAGENT_API_KEY in .env");
  if (!heliusKey) throw new Error("Missing HELIUS_API_KEY in .env");

  const heliusRpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  const lpagentUrl = `https://api.lpagent.io/open-api/v1/lp-positions/opening?owner=${owner}`;

  const lpagent = await fetchJson(lpagentUrl, {
    headers: { "x-api-key": lpagentKey },
  });

  const connection = new Connection(heliusRpcUrl, "confirmed");
  const decodedMap = await DLMM.getAllLbPairPositionsByUser(
    connection,
    new PublicKey(owner),
    { cluster: "mainnet-beta" },
    { chunkSize: 50, isParallelExecution: true },
  );

  const positions = lpagent.data || [];
  const comparisons = [];

  for (const lpPosition of positions) {
    const lp = summarizeLpPosition(lpPosition);
    const decoded = findDecodedPosition(decodedMap, lp.pool, lp.position);
    const positionAccount = await getAccountSummary(heliusRpcUrl, lp.position);
    const poolAccount = await getAccountSummary(heliusRpcUrl, lp.pool);

    const poolMeta = await fetchJson(`https://dlmm.datapi.meteora.ag/pools/${lp.pool}`).catch(
      (error) => ({ error: error.message }),
    );
    const lpagentLogs = await getLpagentLogs(lpagentKey, owner, lp.position).catch(() => []);

    if (!decoded) {
      comparisons.push({
        lpagent: lp,
        onchain: null,
        account: { position: positionAccount, pool: poolAccount },
        errors: ["Position was returned by LPAgent but not decoded from DLMM SDK"],
      });
      continue;
    }

    const poolData = decoded.poolData;
    const positionData = decoded.positionData;
    const onchainToken0 = String(poolData.lbPair && poolData.lbPair.tokenXMint);
    const onchainToken1 = String(poolData.lbPair && poolData.lbPair.tokenYMint);
    const token0 = lp.token0 || onchainToken0;
    const token1 = lp.token1 || onchainToken1;
    const decimal0 = resolveDecimals(lpPosition.decimal0, poolMeta.token_x);
    const decimal1 = resolveDecimals(lpPosition.decimal1, poolMeta.token_y);
    const transactions = await getPositionTransactions(heliusRpcUrl, lp.position);
    const rawFlows = transactions.map((tx) =>
      derivePositionFlowFromTransaction(tx, lp.pool, token0, token1),
    );
    const eventAccounting = await summarizeFlows(
      rawFlows,
      lpagentPriceBySignature(lpagentLogs),
      decimal0,
      decimal1,
      {
        birdeyeKeyRing,
        token0,
        token1,
        poolAddress: lp.pool,
        birdeyeCache: new Map(),
        meteoraOhlcvCache: new Map(),
      },
    );

    const feeXRaw = hexOrBnToNumber(positionData.feeX);
    const feeYRaw = hexOrBnToNumber(positionData.feeY);
    const valueFromRaw = usdValue(
      positionData.totalXAmount,
      decimal0,
      lp.price0,
      positionData.totalYAmount,
      decimal1,
      lp.price1,
    );
    const feeFromRaw = usdValue(feeXRaw, decimal0, lp.price0, feeYRaw, decimal1, lp.price1);

    const pnlFromLpagentFields =
      lp.outputValue + lp.collectedFee + lp.unCollectedFee + lp.value - lp.inputValue;

    const activeId = Number(bnToString(poolData.lbPair && poolData.lbPair.activeId));
    const lowerBinId = Number(positionData.lowerBinId);
    const upperBinId = Number(positionData.upperBinId);
    const lpRangeLower = Array.isArray(lp.range) ? Number(lp.range[0]) : null;
    const lpRangeUpper = Array.isArray(lp.range) ? Number(lp.range[1]) : null;
    const lpRangeActive = Array.isArray(lp.range) ? Number(lp.range[2]) : null;
    const onchainInRange = activeId >= lowerBinId && activeId <= upperBinId;

    comparisons.push({
      lpagent: lp,
      onchain: {
        position: String(matchedPublicKey(decoded)),
        pool: String(poolData.publicKey),
        owner: String(positionData.owner),
        lbPair: {
          activeId,
          binStep: Number(bnToString(poolData.lbPair && poolData.lbPair.binStep)),
          tokenXMint: onchainToken0,
          tokenYMint: onchainToken1,
        },
        pricingTokens: {
          token0,
          token1,
          token0Source: lp.token0 ? "lpagent" : "onchain_fallback",
          token1Source: lp.token1 ? "lpagent" : "onchain_fallback",
          decimal0,
          decimal1,
        },
        lowerBinId,
        upperBinId,
        inRange: onchainInRange,
        totalXAmount: bnToString(positionData.totalXAmount),
        totalYAmount: bnToString(positionData.totalYAmount),
        totalXAmountAdjusted: adjustedAmount(positionData.totalXAmount, decimal0),
        totalYAmountAdjusted: adjustedAmount(positionData.totalYAmount, decimal1),
        feeXRaw,
        feeYRaw,
        feeXAdjusted: adjustedAmount(feeXRaw, decimal0),
        feeYAdjusted: adjustedAmount(feeYRaw, decimal1),
        lastUpdatedAt: new Date(hexOrBnToNumber(positionData.lastUpdatedAt) * 1000).toISOString(),
      },
      recomputed: {
        valueFromRaw,
        feeFromRaw,
        pnlFromLpagentFields,
      },
      eventAccounting: {
        source: {
          amounts: "Helius getTransaction token-balance reserve deltas",
          lpagentLogPrices: "LPAgent logs price0/price1 by txHash (benchmark source)",
          birdeyePrices: birdeyeKeys.length
            ? `Birdeye history_price 1m nearest candle (${birdeyeKeys.length} key(s), round-robin)`
            : "missing BIRD_EYE_API_KEY/BIRDEYE_API_KEY",
          meteoraPoolPrices:
            "Meteora DLMM OHLCV 5m previous candle close * Birdeye SOL/USD",
        },
        lpagentPriceDataAvailable:
          Boolean(lp.token0 && lp.token1) || lp.inputValue !== 0 || lp.outputValue !== 0,
        totals: eventAccounting.totals,
        diffVsLpagent: {
          lpagentLogInputValue: eventAccounting.totals.lpagentLogInputUsd - lp.inputValue,
          lpagentLogOutputValue: eventAccounting.totals.lpagentLogOutputUsd - lp.outputValue,
          birdeyeInputValue: eventAccounting.totals.birdeyeInputUsd - lp.inputValue,
          birdeyeOutputValue: eventAccounting.totals.birdeyeOutputUsd - lp.outputValue,
          meteoraPoolInputValue: eventAccounting.totals.meteoraPoolInputUsd - lp.inputValue,
          meteoraPoolOutputValue: eventAccounting.totals.meteoraPoolOutputUsd - lp.outputValue,
          inputToken0:
            eventAccounting.totals.input0 - Number(lpPosition.inputToken0 || 0),
          inputToken1:
            eventAccounting.totals.input1 - Number(lpPosition.inputToken1 || 0),
        },
        matches: {
          inputToken0:
            String(eventAccounting.totals.input0) === String(lpPosition.inputToken0 || ""),
          inputToken1:
            String(eventAccounting.totals.input1) === String(lpPosition.inputToken1 || ""),
          lpagentLogOutputValue: closeEnough(
            eventAccounting.totals.lpagentLogOutputUsd,
            lp.outputValue,
            1,
          ),
          lpagentLogInputValue: closeEnough(
            eventAccounting.totals.lpagentLogInputUsd,
            lp.inputValue,
            5,
          ),
          birdeyeOutputValue: closeEnough(
            eventAccounting.totals.birdeyeOutputUsd,
            lp.outputValue,
            5,
          ),
          birdeyeInputValue: closeEnough(
            eventAccounting.totals.birdeyeInputUsd,
            lp.inputValue,
            10,
          ),
          meteoraPoolOutputValue: closeEnough(
            eventAccounting.totals.meteoraPoolOutputUsd,
            lp.outputValue,
            10,
          ),
          meteoraPoolInputValue: closeEnough(
            eventAccounting.totals.meteoraPoolInputUsd,
            lp.inputValue,
            20,
          ),
        },
        flows: eventAccounting.flows,
      },
      matches: {
        programOwnerPosition: positionAccount && positionAccount.ownerProgram === DLMM_PROGRAM_ID,
        programOwnerPool: poolAccount && poolAccount.ownerProgram === DLMM_PROGRAM_ID,
        owner: String(positionData.owner) === lp.owner,
        pool: String(poolData.publicKey) === lp.pool,
        position: String(matchedPublicKey(decoded)) === lp.position,
        token0: onchainToken0 === token0,
        token1: onchainToken1 === token1,
        lowerBin: lowerBinId === lpRangeLower || lowerBinId === lp.tickLower,
        upperBin: upperBinId === lpRangeUpper,
        tickUpperRaw: upperBinId === lp.tickUpper,
        activeBin: activeId === lpRangeActive,
        amount0: bnToString(positionData.totalXAmount) === bnToString(lp.current.amount0),
        amount1: bnToString(positionData.totalYAmount) === bnToString(lp.current.amount1),
        unCollectedFee: closeEnough(feeFromRaw, lp.unCollectedFee),
        value: closeEnough(valueFromRaw, lp.value),
        pnl: closeEnough(pnlFromLpagentFields, Number(lp.pnl && lp.pnl.value)),
        inRange: onchainInRange === lp.inRange,
      },
      account: {
        position: positionAccount,
        pool: poolAccount,
      },
      meteoraPool: poolMeta.error
        ? poolMeta
        : {
            name: poolMeta.name,
            current_price: poolMeta.current_price,
            token_x_price: poolMeta.token_x && poolMeta.token_x.price,
            token_y_price: poolMeta.token_y && poolMeta.token_y.price,
            bin_step: poolMeta.pool_config && poolMeta.pool_config.bin_step,
            base_fee_pct: poolMeta.pool_config && poolMeta.pool_config.base_fee_pct,
            tvl: poolMeta.tvl,
          },
    });
  }

  const output = {
    owner,
    lpagent: {
      status: lpagent.status,
      count: lpagent.count,
    },
    onchain: {
      poolCount: decodedMap.size,
    },
    comparisons,
  };

  console.log(JSON.stringify(output, null, 2));
}

function matchedPublicKey(decoded) {
  const positions = decoded.poolData.lbPairPositionsData || [];
  const matched = positions.find(
    (entry) => entry.positionData === decoded.positionData,
  );
  return matched && matched.publicKey;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
