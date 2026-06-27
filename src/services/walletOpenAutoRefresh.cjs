const path = require("path");
const { spawnSync } = require("child_process");
const { getWalletOpenPositionsFromSqlite } = require("./sqlitePositionDetails.cjs");
const { selectJson, sqlText } = require("../db/sqliteCli.cjs");

function latestOwnerSync(dbPath, owner) {
  const rows = selectJson(
    dbPath,
    `
SELECT id, started_at, finished_at
FROM sync_runs
WHERE owner = ${sqlText(owner)}
  AND status = 'success'
ORDER BY id DESC
LIMIT 1;
`,
  );
  return rows[0] || null;
}

function stalenessSeconds(sync) {
  if (!sync || !sync.finished_at) return null;
  return Math.max((Date.now() - new Date(sync.finished_at).getTime()) / 1000, 0);
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(`${path.basename(scriptPath)} failed ${result.status}: ${detail}`);
  }
}

function refreshOwner(owner, dbPath) {
  const ingestScript = path.resolve(process.cwd(), "scripts/ingest-onchain-sqlite.cjs");
  const recomputeScript = path.resolve(process.cwd(), "scripts/recompute-position-metrics-sqlite.cjs");
  runNodeScript(ingestScript, [owner, `--db=${dbPath}`]);
  runNodeScript(recomputeScript, [`--db=${dbPath}`]);
}

function getWalletOpenPositionsAutoRefresh(owner, options = {}) {
  const dbPath = path.resolve(options.dbPath || path.join(process.cwd(), "data/lpscan.sqlite"));
  const ttlSeconds = Math.max(Number(options.ttlSeconds ?? 60), 0);
  const beforeSync = latestOwnerSync(dbPath, owner);
  const beforeStaleness = stalenessSeconds(beforeSync);
  const shouldRefresh = !beforeSync || beforeStaleness == null || beforeStaleness >= ttlSeconds;

  if (shouldRefresh) {
    refreshOwner(owner, dbPath);
  }

  const payload = getWalletOpenPositionsFromSqlite(owner, { dbPath });
  return {
    ...payload,
    source: "sqlite_index_auto_refresh",
    ttlSeconds,
    refreshed: shouldRefresh,
    previousSyncedAt: beforeSync && beforeSync.finished_at,
    previousStalenessSeconds: beforeStaleness,
  };
}

module.exports = {
  getWalletOpenPositionsAutoRefresh,
};
