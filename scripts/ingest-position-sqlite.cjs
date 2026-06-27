const path = require("path");
const { scanPositionHistory } = require("../src/services/indexer/positionHistoryScanner.cjs");
const { ensureDatabase, runTransaction, selectJson, sqlInteger } = require("../src/db/sqliteCli.cjs");
const {
  argValue,
  createSyncRun,
  finishSyncRun,
  readEnv,
  upsertEvent,
  upsertHistoricalPrice,
  upsertMetrics,
  upsertPool,
  upsertPosition,
} = require("./ingest-onchain-sqlite.cjs");

async function main() {
  const position = process.argv.find(
    (arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1],
  );
  if (!position) {
    throw new Error("Usage: node scripts/ingest-position-sqlite.cjs <position> [--db=data/lpscan.sqlite]");
  }

  const dbPath = path.resolve(process.cwd(), argValue("db", "data/lpscan.sqlite"));
  const schemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
  const env = readEnv(path.resolve(process.cwd(), ".env"));
  const now = new Date().toISOString();

  ensureDatabase(dbPath, schemaPath);
  const syncRunId = createSyncRun(dbPath, position, now);

  try {
    const history = await scanPositionHistory(position, {
      heliusApiKey: env.HELIUS_API_KEY,
      birdeyeApiKeys: env.BIRD_EYE_API_KEY || env.BIRDEYE_API_KEY || "",
      limit: Number(argValue("limit", "100")),
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
    finishSyncRun(
      dbPath,
      syncRunId,
      "success",
      new Date().toISOString(),
      { positionCount: 1, eventCount: history.events.length },
    );

    const summary = selectJson(
      dbPath,
      `
SELECT
  sr.id AS syncRunId,
  sr.owner AS target,
  sr.position_count AS positionCount,
  sr.event_count AS eventCount,
  (SELECT COUNT(*) FROM position_events WHERE sync_run_id = sr.id AND reserve_delta_check_matches = 0) AS reserveDeltaMismatchCount,
  (SELECT GROUP_CONCAT(action_type || ':' || count, ', ') FROM (
    SELECT action_type, COUNT(*) AS count
    FROM position_events
    WHERE sync_run_id = sr.id
    GROUP BY action_type
    ORDER BY action_type
  )) AS actionCounts
FROM sync_runs sr
WHERE sr.id = ${sqlInteger(syncRunId)};
`,
    )[0];

    console.log(JSON.stringify({ dbPath, ...summary }, null, 2));
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

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
