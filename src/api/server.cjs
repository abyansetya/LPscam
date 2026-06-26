const http = require("http");
const fs = require("fs");
const path = require("path");
const { getOpenPositionsForWallet } = require("../services/onchainOpenPositions.cjs");
const {
  getPositionDetailFromSqlite,
  getPositionLogsFromSqlite,
} = require("../services/sqlitePositionDetails.cjs");

function readEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;

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

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function routeWalletOpenPositions(pathname) {
  const match = pathname.match(/^\/wallets\/([^/]+)\/positions\/open$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function routePositionDetail(pathname) {
  const match = pathname.match(/^\/positions\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function routePositionLogs(pathname) {
  const match = pathname.match(/^\/positions\/([^/]+)\/logs$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function handleRequest(request, response, config) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  const owner = request.method === "GET" ? routeWalletOpenPositions(url.pathname) : null;
  if (owner) {
    const payload = await getOpenPositionsForWallet(owner, config);
    sendJson(response, 200, payload);
    return;
  }

  const logsPosition = request.method === "GET" ? routePositionLogs(url.pathname) : null;
  if (logsPosition) {
    const payload = getPositionLogsFromSqlite(logsPosition, { dbPath: config.dbPath });
    sendJson(response, payload.status === "success" ? 200 : 404, payload);
    return;
  }

  const position = request.method === "GET" ? routePositionDetail(url.pathname) : null;
  if (position) {
    const payload = getPositionDetailFromSqlite(position, { dbPath: config.dbPath });
    sendJson(response, payload.status === "success" ? 200 : 404, payload);
    return;
  }

  sendJson(response, 404, {
    status: "error",
    message: "Not found",
    routes: [
      "GET /health",
      "GET /wallets/:owner/positions/open",
      "GET /positions/:position",
      "GET /positions/:position/logs",
    ],
  });
}

function startServer() {
  const root = path.resolve(__dirname, "..", "..");
  const env = { ...process.env, ...readEnv(path.join(root, ".env")) };
  const config = {
    heliusApiKey: env.HELIUS_API_KEY,
    birdeyeApiKeys: env.BIRD_EYE_API_KEY || env.BIRDEYE_API_KEY || "",
    dbPath: path.resolve(root, env.SQLITE_DB_PATH || "data/lpscan.sqlite"),
  };

  const port = Number(env.PORT || 8787);
  const server = http.createServer((request, response) => {
    handleRequest(request, response, config).catch((error) => {
      sendJson(response, 500, {
        status: "error",
        message: error.message,
      });
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`On-chain LP API listening on http://127.0.0.1:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
};
