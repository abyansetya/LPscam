const path = require("path");
const { runTransaction, selectJson, sqlInteger, sqlReal, sqlText } = require("../db/sqliteCli.cjs");

function numeric(value) {
  if (value == null || value === "") return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function metricSql(positionAddress, metrics, now) {
  return `
INSERT INTO position_metrics (
  position_address,
  input0_raw, input1_raw, output0_raw, output1_raw,
  input_value_usd, output_value_usd, current_value_usd,
  unclaimed_fee_usd, collected_fee_usd,
  pnl_usd, pnl_percent, event_count,
  sync_run_id, updated_at
) VALUES (
  ${sqlText(positionAddress)},
  ${sqlText(metrics.input0Raw)}, ${sqlText(metrics.input1Raw)},
  ${sqlText(metrics.output0Raw)}, ${sqlText(metrics.output1Raw)},
  ${sqlReal(metrics.inputValueUsd)}, ${sqlReal(metrics.outputValueUsd)},
  ${sqlReal(metrics.currentValueUsd)}, ${sqlReal(metrics.unclaimedFeeUsd)},
  ${sqlReal(metrics.collectedFeeUsd)}, ${sqlReal(metrics.pnlUsd)},
  ${sqlReal(metrics.pnlPercent)}, ${sqlInteger(metrics.eventCount)},
  NULL, ${sqlText(now)}
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

function loadPositionRows(dbPath, positionAddress) {
  const positionFilter = positionAddress ? `WHERE p.position_address = ${sqlText(positionAddress)}` : "";
  return selectJson(
    dbPath,
    `
SELECT
  p.position_address,
  p.status,
  COALESCE(m.current_value_usd, 0) AS current_value_usd,
  COALESCE(m.unclaimed_fee_usd, 0) AS unclaimed_fee_usd
FROM positions p
LEFT JOIN position_metrics m ON m.position_address = p.position_address
${positionFilter}
ORDER BY p.position_address;
`,
  );
}

function loadEventRows(dbPath, positionAddress) {
  return selectJson(
    dbPath,
    `
SELECT
  action_type,
  input0_raw,
  input1_raw,
  output0_raw,
  output1_raw,
  input_value_usd,
  output_value_usd
FROM position_events
WHERE position_address = ${sqlText(positionAddress)}
ORDER BY block_time, outer_instruction_index, inner_instruction_index, event_type;
`,
  );
}

function computeMetrics(positionRow, eventRows) {
  const nonFeeEvents = eventRows.filter((event) => event.action_type !== "claim_fee");
  const feeEvents = eventRows.filter((event) => event.action_type === "claim_fee");
  const input0Raw = nonFeeEvents.reduce((sum, event) => sum + numeric(event.input0_raw), 0);
  const input1Raw = nonFeeEvents.reduce((sum, event) => sum + numeric(event.input1_raw), 0);
  const output0Raw = nonFeeEvents.reduce((sum, event) => sum + numeric(event.output0_raw), 0);
  const output1Raw = nonFeeEvents.reduce((sum, event) => sum + numeric(event.output1_raw), 0);
  const inputValueUsd = nonFeeEvents.reduce((sum, event) => sum + numeric(event.input_value_usd), 0);
  const outputValueUsd = nonFeeEvents.reduce((sum, event) => sum + numeric(event.output_value_usd), 0);
  const collectedFeeUsd = feeEvents.reduce((sum, event) => sum + numeric(event.output_value_usd), 0);
  const currentValueUsd = positionRow.status === "Open" ? numeric(positionRow.current_value_usd) : 0;
  const unclaimedFeeUsd = positionRow.status === "Open" ? numeric(positionRow.unclaimed_fee_usd) : 0;
  const pnlUsd =
    outputValueUsd + collectedFeeUsd + currentValueUsd + unclaimedFeeUsd - inputValueUsd;
  const pnlPercent = inputValueUsd > 0 ? (pnlUsd / inputValueUsd) * 100 : null;

  return {
    input0Raw: String(input0Raw),
    input1Raw: String(input1Raw),
    output0Raw: String(output0Raw),
    output1Raw: String(output1Raw),
    inputValueUsd,
    outputValueUsd,
    currentValueUsd,
    unclaimedFeeUsd,
    collectedFeeUsd,
    pnlUsd,
    pnlPercent,
    eventCount: eventRows.length,
  };
}

function recomputePositionMetrics(options = {}) {
  const dbPath = path.resolve(options.dbPath || path.join(process.cwd(), "data/lpscan.sqlite"));
  const positionRows = loadPositionRows(dbPath, options.positionAddress);
  const now = new Date().toISOString();
  const statements = [];
  const summaries = [];

  for (const positionRow of positionRows) {
    const eventRows = loadEventRows(dbPath, positionRow.position_address);
    const metrics = computeMetrics(positionRow, eventRows);
    statements.push(metricSql(positionRow.position_address, metrics, now));
    summaries.push({
      position: positionRow.position_address,
      status: positionRow.status,
      ...metrics,
    });
  }

  runTransaction(dbPath, statements);
  return {
    dbPath,
    count: summaries.length,
    positions: summaries,
  };
}

module.exports = {
  computeMetrics,
  recomputePositionMetrics,
};
