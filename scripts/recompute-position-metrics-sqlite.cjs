const path = require("path");
const { recomputePositionMetrics } = require("../src/services/indexer/positionMetricsRecompute.cjs");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function positionalArg() {
  return process.argv.find(
    (arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1],
  );
}

function main() {
  const positionAddress = positionalArg();
  const dbPath = path.resolve(process.cwd(), argValue("db", "data/lpscan.sqlite"));
  const result = recomputePositionMetrics({ dbPath, positionAddress });
  console.log(JSON.stringify(result, null, 2));
}

main();
