const path = require("path");

const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const ANCHOR_EVENT_CPI_DISCRIMINATOR_LENGTH = 8;

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

const bs58Module = loadDependency("bs58");
const bs58 = bs58Module.default || bs58Module;
const { BorshCoder } = loadDependency("@coral-xyz/anchor");
const { IDL } = loadDependency("@meteora-ag/dlmm");

const eventCoder = new BorshCoder(IDL);

function bnToString(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  if (typeof value.toString === "function") return value.toString();
  return String(value);
}

function normalizeValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  if (typeof value.toString === "function" && value.constructor && value.constructor.name === "BN") {
    return value.toString();
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, normalizeValue(entryValue)]),
  );
}

function resolveAccountKey(accountKey) {
  if (accountKey == null) return null;
  if (typeof accountKey === "string") return accountKey;
  if (typeof accountKey.toBase58 === "function") return accountKey.toBase58();
  if (accountKey.pubkey) return resolveAccountKey(accountKey.pubkey);
  return String(accountKey);
}

function getTransactionAccountKeys(tx) {
  const accountKeys = tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
  return (accountKeys || []).map(resolveAccountKey);
}

function getInstructionProgramId(instruction, accountKeys) {
  if (instruction.programId) return resolveAccountKey(instruction.programId);
  if (instruction.programIdIndex != null) return accountKeys[instruction.programIdIndex];
  return null;
}

function getInstructionAccounts(instruction, accountKeys) {
  if (!instruction.accounts) return [];
  return instruction.accounts.map((account) =>
    typeof account === "number" ? accountKeys[account] : resolveAccountKey(account),
  );
}

function decodeDlmmEventData(data) {
  if (!data) return null;

  const bytes = Buffer.from(bs58.decode(data));
  if (bytes.length <= ANCHOR_EVENT_CPI_DISCRIMINATOR_LENGTH) return null;

  return eventCoder.events.decode(
    bytes.slice(ANCHOR_EVENT_CPI_DISCRIMINATOR_LENGTH).toString("base64"),
  );
}

function normalizeDecodedEvent(decoded, context) {
  const raw = normalizeValue(decoded.data);
  const amounts = Array.isArray(raw.amounts) ? raw.amounts : [];
  const rewards = Array.isArray(raw.rewards) ? raw.rewards : [];

  return {
    signature: context.signature,
    slot: context.slot,
    blockTime: context.blockTime,
    timestamp: context.blockTime ? new Date(context.blockTime * 1000).toISOString() : null,
    outerInstructionIndex: context.outerInstructionIndex,
    innerInstructionIndex: context.innerInstructionIndex,
    eventType: decoded.name,
    actionType: dlmmActionType(decoded.name),
    pool: raw.lb_pair || raw.lbPair || null,
    owner: raw.owner || raw.from || raw.sender || null,
    position: raw.position || null,
    amount0Raw: amounts[0] || raw.amount_x || raw.amountX || raw.token_x_amount || null,
    amount1Raw: amounts[1] || raw.amount_y || raw.amountY || raw.token_y_amount || null,
    activeBinId: raw.active_bin_id ?? raw.activeId ?? null,
    oldLowerBinId: raw.old_min_id ?? null,
    oldUpperBinId: raw.old_max_id ?? null,
    newLowerBinId: raw.new_min_id ?? null,
    newUpperBinId: raw.new_max_id ?? null,
    claimedFee0Raw: raw.fee_x || raw.x_fee_amount || null,
    claimedFee1Raw: raw.fee_y || raw.y_fee_amount || null,
    claimedRewardRaw: raw.total_reward || null,
    rewardIndex: raw.reward_index ?? null,
    reward0Raw: rewards[0] || null,
    reward1Raw: rewards[1] || null,
    rebalance: decoded.name === "Rebalancing"
      ? {
          withdrawn0Raw: raw.x_withdrawn_amount || "0",
          withdrawn1Raw: raw.y_withdrawn_amount || "0",
          added0Raw: raw.x_added_amount || "0",
          added1Raw: raw.y_added_amount || "0",
          fee0Raw: raw.x_fee_amount || "0",
          fee1Raw: raw.y_fee_amount || "0",
          oldLowerBinId: raw.old_min_id ?? null,
          oldUpperBinId: raw.old_max_id ?? null,
          newLowerBinId: raw.new_min_id ?? null,
          newUpperBinId: raw.new_max_id ?? null,
          rewards,
        }
      : null,
    accounts: context.accounts,
    raw,
  };
}

function dlmmActionType(eventType) {
  switch (eventType) {
    case "AddLiquidity":
      return "liquidity_add";
    case "RemoveLiquidity":
      return "liquidity_remove";
    case "Rebalancing":
      return "rebalance";
    case "ClaimFee":
    case "ClaimFee2":
      return "claim_fee";
    case "ClaimReward":
    case "ClaimReward2":
      return "claim_reward";
    case "PositionCreate":
      return "position_create";
    case "PositionClose":
      return "position_close";
    default:
      return "other";
  }
}

function decodeDlmmEventsFromTransaction(tx) {
  const signature = tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0];
  const accountKeys = getTransactionAccountKeys(tx);
  const events = [];

  for (const group of (tx.meta && tx.meta.innerInstructions) || []) {
    for (const [innerInstructionIndex, instruction] of (group.instructions || []).entries()) {
      const programId = getInstructionProgramId(instruction, accountKeys);
      if (programId !== DLMM_PROGRAM_ID || !instruction.data) continue;

      const decoded = decodeDlmmEventData(instruction.data);
      if (!decoded) continue;

      events.push(
        normalizeDecodedEvent(decoded, {
          signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          outerInstructionIndex: group.index,
          innerInstructionIndex,
          accounts: getInstructionAccounts(instruction, accountKeys),
        }),
      );
    }
  }

  return events;
}

module.exports = {
  DLMM_PROGRAM_ID,
  bnToString,
  decodeDlmmEventsFromTransaction,
  dlmmActionType,
};
