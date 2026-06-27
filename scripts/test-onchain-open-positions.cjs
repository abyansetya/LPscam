const fs = require("fs");
const path = require("path");
const { getOpenPositionsForWallet } = require("../src/services/onchain/onchainOpenPositions.cjs");

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

async function main() {
  const owner = process.argv[2];
  if (!owner) {
    throw new Error("Usage: node scripts/test-onchain-open-positions.cjs <owner>");
  }

  const env = readEnv(path.resolve(process.cwd(), ".env"));
  const result = await getOpenPositionsForWallet(owner, {
    heliusApiKey: env.HELIUS_API_KEY,
    birdeyeApiKeys: env.BIRD_EYE_API_KEY || env.BIRDEYE_API_KEY || "",
  });

  const summary = {
    owner: result.data.owner,
    count: result.data.count,
    positions: result.data.positions.map((position) => ({
      pairName: position.pairName,
      position: position.position,
      pool: position.pool,
      inRange: position.range.inRange,
      currentValueUsd: position.accounting.currentValueUsd,
      inputValueUsd: position.accounting.inputValueUsd,
      outputValueUsd: position.accounting.outputValueUsd,
      unclaimedFeeUsd: position.accounting.unclaimedFeeUsd,
      pnlUsd: position.accounting.pnlUsd,
      pnlPercent: position.accounting.pnlPercent,
      eventCount: position.events.length,
      events: position.events.map((event) => ({
        signature: event.signature,
        slot: event.slot,
        blockTime: event.blockTime,
        timestamp: event.timestamp,
        instruction: event.instruction,
        eventType: event.eventType,
        actionType: event.actionType,
        accountingSource: event.accountingSource,
        poolDelta0: event.poolDelta0,
        poolDelta1: event.poolDelta1,
        input0: event.input0,
        input1: event.input1,
        output0: event.output0,
        output1: event.output1,
        claimedFee0Raw: event.claimedFee0Raw,
        claimedFee1Raw: event.claimedFee1Raw,
        claimedRewardRaw: event.claimedRewardRaw,
        rewardIndex: event.rewardIndex,
        reserveDeltaCheck: event.reserveDeltaCheck || null,
        decodedDlmmEvent: event.decodedDlmmEvent || null,
        decodedDlmmEvents: event.decodedDlmmEvents,
        price0: event.price0,
        price1: event.price1,
        inputValueUsd: event.inputValueUsd,
        outputValueUsd: event.outputValueUsd,
      })),
      sources: position.sources,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
