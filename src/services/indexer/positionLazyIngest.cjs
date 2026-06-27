const path = require("path");
const { scanPositionHistory } = require("./positionHistoryScanner.cjs");
const { ensureDatabase, runTransaction } = require("../../db/sqliteCli.cjs");
const {
  createSyncRun,
  finishSyncRun,
  upsertEvent,
  upsertHistoricalPrice,
  upsertMetrics,
  upsertPool,
  upsertPosition,
} = require("../../../scripts/ingest-onchain-sqlite.cjs");
const { recomputePositionMetrics } = require("./positionMetricsRecompute.cjs");

async function ingestPositionHistoryToSqlite(positionAddress, config = {}) {
  const dbPath = path.resolve(config.dbPath || path.join(process.cwd(), "data/lpscan.sqlite"));
  const schemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
  const now = new Date().toISOString();

  ensureDatabase(dbPath, schemaPath);
  const syncRunId = createSyncRun(dbPath, positionAddress, now);

  try {
    const history = await scanPositionHistory(positionAddress, {
      heliusApiKey: config.heliusApiKey,
      birdeyeApiKeys: config.birdeyeApiKeys || "",
      lpagentKey: config.lpagentKey || "",
      limit: Number(config.positionHistoryLimit || 100),
    });

    const statements = [
      upsertPool(history, now),
      upsertPosition(history, now),
      upsertMetrics(history, syncRunId, now),
    ];

    for (const event of history.events) {
      statements.push(upsertEvent(history, event, syncRunId, now));
      for (const price of [event.price0, event.price1]) {
        const statement = upsertHistoricalPrice(price, now);
        if (statement) statements.push(statement);
      }
    }

    runTransaction(dbPath, statements);
    recomputePositionMetrics({ dbPath, positionAddress });
    finishSyncRun(
      dbPath,
      syncRunId,
      "success",
      new Date().toISOString(),
      { positionCount: 1, eventCount: history.events.length },
    );

    return {
      dbPath,
      syncRunId,
      position: positionAddress,
      owner: history.owner,
      eventCount: history.events.length,
    };
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

module.exports = {
  ingestPositionHistoryToSqlite,
};
