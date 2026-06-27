const http = require("http");
const fs = require("fs");
const path = require("path");
const { getOpenPositionsForWallet } = require("../services/onchain/onchainOpenPositions.cjs");
const { getWalletOpenPositionsHybrid } = require("../services/api/hybridOpenPositions.cjs");
const { ingestPositionHistoryToSqlite } = require("../services/indexer/positionLazyIngest.cjs");
const { overlayPositionDetailWithRealtime } = require("../services/api/positionRealtimeOverlay.cjs");
const { getWalletOpenPositionsAutoRefresh } = require("../services/api/walletOpenAutoRefresh.cjs");
const {
  getPositionDetailFromSqlite,
  getPositionLogsFromSqlite,
  getWalletOpenPositionsFromSqlite,
} = require("../services/api/sqlitePositionDetails.cjs");

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
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  response.end(body);
}

function sendOptions(response) {
  response.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  });
  response.end();
}

function includes(searchParams, name) {
  const raw = searchParams.get("include");
  if (!raw) return false;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(name);
}

function withMeta(payload, meta) {
  return {
    ...payload,
    meta: {
      ...(payload.meta || {}),
      ...meta,
    },
  };
}

function prunePositionDetail(payload, searchParams) {
  if (!payload || payload.status !== "success" || !payload.data) return payload;
  const includeEvents = includes(searchParams, "events");
  const includeBins = includes(searchParams, "bins");
  const data = { ...payload.data };
  const omitted = [];

  if (!includeEvents && Array.isArray(data.events)) {
    data.eventCount = data.events.length;
    delete data.events;
    omitted.push("events");
  }

  if (!includeBins && Array.isArray(data.bins)) {
    data.binCount = data.bins.length;
    delete data.bins;
    omitted.push("bins");
  }

  return withMeta(
    {
      ...payload,
      data,
    },
    {
      include: {
        events: includeEvents,
        bins: includeBins,
      },
      omitted,
    },
  );
}

function routeWalletOpenPositions(pathname) {
  const match = pathname.match(/^\/wallets\/([^/]+)\/positions\/open$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function routeWalletOpenIndexedPositions(pathname) {
  const match = pathname.match(/^\/wallets\/([^/]+)\/positions\/open-indexed$/);
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

function routePositionBins(pathname) {
  const match = pathname.match(/^\/positions\/([^/]+)\/bins$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function errorPayload(code, message, extra = {}) {
  return {
    status: "error",
    code,
    message,
    retryable: Boolean(extra.retryable),
    ...extra,
  };
}

async function handleRequest(request, response, config) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    sendOptions(response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  const owner = request.method === "GET" ? routeWalletOpenPositions(url.pathname) : null;
  if (owner) {
    const forceLive = url.searchParams.get("live") === "1";
    const mode = url.searchParams.get("mode");
    const ttlSeconds = Number(url.searchParams.get("ttl") || config.openPositionsTtlSeconds);
    let payload;
    if (mode === "hybrid") {
      payload = await getWalletOpenPositionsHybrid(owner, config);
    } else if (forceLive) {
      payload = await getOpenPositionsForWallet(owner, config);
    } else {
      payload = getWalletOpenPositionsAutoRefresh(owner, {
        dbPath: config.dbPath,
        ttlSeconds,
      });
    }
    sendJson(response, 200, payload);
    return;
  }

  const indexedOwner = request.method === "GET" ? routeWalletOpenIndexedPositions(url.pathname) : null;
  if (indexedOwner) {
    const payload = getWalletOpenPositionsFromSqlite(indexedOwner, { dbPath: config.dbPath });
    sendJson(response, 200, payload);
    return;
  }

  const logsPosition = request.method === "GET" ? routePositionLogs(url.pathname) : null;
  if (logsPosition) {
    const payload = getPositionLogsFromSqlite(logsPosition, { dbPath: config.dbPath });
    sendJson(
      response,
      payload.status === "success" ? 200 : 404,
      payload.status === "success"
        ? withMeta(payload, { source: "sqlite_position_events" })
        : errorPayload("POSITION_LOGS_NOT_FOUND", payload.message, { retryable: false }),
    );
    return;
  }

  const binsPosition = request.method === "GET" ? routePositionBins(url.pathname) : null;
  if (binsPosition) {
    let detail = getPositionDetailFromSqlite(binsPosition, { dbPath: config.dbPath });
    if (detail.status === "success") {
      try {
        detail = {
          ...detail,
          data: await overlayPositionDetailWithRealtime(detail.data, config),
          source: "sqlite_with_realtime_overlay",
        };
      } catch (error) {
        detail = {
          ...detail,
          realtimeOverlayError: error.message,
        };
      }
    }

    if (detail.status !== "success") {
      sendJson(
        response,
        404,
        errorPayload("POSITION_NOT_FOUND", detail.message, { retryable: true }),
      );
      return;
    }

    sendJson(response, 200, {
      status: "success",
      source: detail.source || "position_detail",
      count: Array.isArray(detail.data.bins) ? detail.data.bins.length : 0,
      data: Array.isArray(detail.data.bins) ? detail.data.bins : [],
      meta: {
        position: binsPosition,
        realtimeOverlayError: detail.realtimeOverlayError || null,
      },
    });
    return;
  }

  const position = request.method === "GET" ? routePositionDetail(url.pathname) : null;
  if (position) {
    const refresh = url.searchParams.get("refresh") === "1";
    const live = url.searchParams.get("live") !== "0";
    let payload = refresh
      ? { status: "error", message: "Forced refresh requested." }
      : getPositionDetailFromSqlite(position, { dbPath: config.dbPath });
    const meta = {
      position,
      cache: payload.status === "success" && !refresh ? "hit" : "miss",
      lazyIngested: false,
      realtimeOverlay: live ? "pending" : "disabled",
      refresh,
    };

    if (payload.status !== "success") {
      try {
        const ingest = await ingestPositionHistoryToSqlite(position, config);
        payload = getPositionDetailFromSqlite(position, { dbPath: config.dbPath });
        meta.cache = "miss";
        meta.lazyIngested = true;
        if (payload.status === "success") {
          payload = {
            ...payload,
            source: "sqlite_after_lazy_onchain_ingest",
            lazyIngest: ingest,
          };
        }
      } catch (error) {
        payload = {
          ...errorPayload(
            "POSITION_LOOKUP_FAILED",
            "Position not found in SQLite and on-chain lookup failed.",
            { retryable: true },
          ),
          sqliteMessage: payload.message,
          onchainError: error.message,
        };
      }
    }

    if (payload.status === "success" && live) {
      try {
        payload = {
          ...payload,
          data: await overlayPositionDetailWithRealtime(payload.data, config),
          source: payload.source || "sqlite_with_realtime_overlay",
        };
        meta.realtimeOverlay = "success";
      } catch (error) {
        payload = {
          ...payload,
          realtimeOverlayError: error.message,
        };
        meta.realtimeOverlay = "failed";
        meta.realtimeOverlayError = error.message;
      }
    }

    if (payload.status === "success" && !payload.source) {
      payload = {
        ...payload,
        source: "sqlite_position_events",
      };
    }

    sendJson(
      response,
      payload.status === "success" ? 200 : 404,
      payload.status === "success"
        ? prunePositionDetail(withMeta(payload, meta), url.searchParams)
        : withMeta(payload, meta),
    );
    return;
  }

  sendJson(response, 404, {
    status: "error",
    code: "NOT_FOUND",
    message: "Not found",
    retryable: false,
    routes: [
      "GET /health",
      "GET /wallets/:owner/positions/open",
      "GET /wallets/:owner/positions/open?mode=hybrid",
      "GET /wallets/:owner/positions/open-indexed",
      "GET /positions/:position?live=0|1&include=events,bins",
      "GET /positions/:position/bins",
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
    openPositionsTtlSeconds: Number(env.OPEN_POSITIONS_TTL_SECONDS || 60),
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
