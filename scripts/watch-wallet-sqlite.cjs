const { spawnSync } = require("child_process");
const path = require("path");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function positionalArg() {
  return process.argv.find(
    (arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1],
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error,
  };
}

function lastJsonObject(text) {
  if (!text) return null;
  const start = text.lastIndexOf("\n{");
  const jsonText = start >= 0 ? text.slice(start + 1) : text;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function main() {
  const owner = positionalArg();
  if (!owner) {
    throw new Error(
      "Usage: node scripts/watch-wallet-sqlite.cjs <owner> [--interval=60] [--db=data/lpscan.sqlite] [--once]",
    );
  }

  const intervalSeconds = Math.max(Number(argValue("interval", "60")), 5);
  const dbPath = path.resolve(process.cwd(), argValue("db", "data/lpscan.sqlite"));
  const once = hasFlag("once");
  const ingestScript = path.resolve(process.cwd(), "scripts/ingest-onchain-sqlite.cjs");
  const recomputeScript = path.resolve(process.cwd(), "scripts/recompute-position-metrics-sqlite.cjs");
  let cycle = 0;
  let consecutiveFailures = 0;

  while (true) {
    cycle += 1;
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();

    console.log(
      JSON.stringify({
        event: "sync_start",
        cycle,
        owner,
        intervalSeconds,
        startedAt: startedAtIso,
      }),
    );

    const ingest = runNodeScript(ingestScript, [owner, `--db=${dbPath}`]);
    const ingestSummary = lastJsonObject(ingest.stdout);
    if (ingest.status !== 0) {
      consecutiveFailures += 1;
      console.error(
        JSON.stringify({
          event: "sync_failed",
          cycle,
          owner,
          stage: "ingest",
          status: ingest.status,
          error: ingest.error && ingest.error.message,
          stderr: ingest.stderr,
          stdout: ingest.stdout,
          consecutiveFailures,
        }),
      );
    } else {
      const recompute = runNodeScript(recomputeScript, [`--db=${dbPath}`]);
      const recomputeSummary = lastJsonObject(recompute.stdout);
      if (recompute.status !== 0) {
        consecutiveFailures += 1;
        console.error(
          JSON.stringify({
            event: "sync_failed",
            cycle,
            owner,
            stage: "recompute",
            status: recompute.status,
            error: recompute.error && recompute.error.message,
            stderr: recompute.stderr,
            stdout: recompute.stdout,
            consecutiveFailures,
          }),
        );
      } else {
        consecutiveFailures = 0;
        const finishedAt = Date.now();
        console.log(
          JSON.stringify({
            event: "sync_success",
            cycle,
            owner,
            durationSeconds: (finishedAt - startedAt) / 1000,
            ingest: ingestSummary,
            recompute: recomputeSummary && {
              count: recomputeSummary.count,
            },
            finishedAt: new Date(finishedAt).toISOString(),
          }),
        );
      }
    }

    if (once) break;

    const backoffMultiplier = consecutiveFailures ? Math.min(2 ** consecutiveFailures, 8) : 1;
    const nextDelaySeconds = intervalSeconds * backoffMultiplier;
    console.log(
      JSON.stringify({
        event: "sync_sleep",
        owner,
        nextDelaySeconds,
        consecutiveFailures,
      }),
    );
    await sleep(nextDelaySeconds * 1000);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
