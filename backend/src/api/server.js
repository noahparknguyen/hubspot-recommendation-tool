const http = require("node:http");
const { URL } = require("node:url");
const { randomUUID } = require("node:crypto");

const { handleAnalyze } = require("./routes/analyze");
const { startAnalysisThread } = require("../core/worker/runAnalysis");
const { config } = require("../core/config");
const { tryServeStatic, tryServeSpaFallback } = require("./static");
const { isAuthorized, sendAuthChallenge } = require("./auth");
const { createRateLimiter } = require("./rateLimit");
const { getClientIp } = require("./clientIp");

// Keep the HTTP surface intentionally small and stable.

let isShuttingDown = false;

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");

  // This server may also serve the frontend statically, but a useful CSP usually
  // depends on the exact HTML/build output and deployment environment. It is safer
  // to set CSP at the reverse proxy layer or alongside the frontend document policy
  // rather than hard-coding one here.
}

function setCors(req, res) {
  // If the frontend is served from the same origin in production, CORS is usually unnecessary.
  // Allow opt-in tightening (or disabling) via config.
  if (String(config.cors.allowOrigin).toLowerCase() === "off") return;
  if (
    config.env === "production" &&
    config.static.enabled &&
    config.cors.allowOrigin === "*"
  ) {
    return;
  }

  // Minimal CORS primarily for local dev + simple deployments.
  // If deploying behind a reverse proxy, tightening CORS there is often cleaner.
  const origin = req.headers.origin;

  if (config.cors.allowOrigin === "*" || !origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin === config.cors.allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Request-Id, Authorization",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, payload, pretty) {
  const body = pretty
    ? JSON.stringify(payload, null, 2)
    : JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function sendRateLimited(res, retryAfterSeconds, pretty) {
  const seconds = Number.isFinite(Number(retryAfterSeconds))
    ? Number(retryAfterSeconds)
    : 60;

  res.statusCode = 429;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", String(seconds));

  const payload = {
    ok: false,
    error: "Too many attempts. Please try again later.",
    retryAfterSeconds: seconds,
  };

  res.end(pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
}

// --- Route matching helpers ---
function getPretty(requestUrl) {
  const v = requestUrl.searchParams.get("pretty");
  return v === "1" || v === "true";
}

function isHealthPath(pathname) {
  return pathname === "/health" || pathname === "/api/health";
}

function isAnalyzePath(pathname) {
  return pathname === "/analyze" || pathname === "/api/analyze";
}

// --- Request logging ---
function logRequest(req, res, requestUrl, requestId, startMs) {
  if (!config.logging.requestLog) return;

  const ms = Date.now() - startMs;
  const msg = {
    level: "info",
    msg: "request",
    requestId,
    method: req.method,
    path: requestUrl.pathname,
    statusCode: res.statusCode,
    durationMs: ms,
  };

  // Structured logs (JSON) play well with container logging.
  console.log(JSON.stringify(msg));
}

// Best-effort in-memory limiter for failed auth attempts.
// This protects a single process; distributed deployments should add edge-level limits too.
const authRateLimiter = createRateLimiter(
  config.auth && config.auth.rateLimit ? config.auth.rateLimit : undefined,
);

// Fail fast if auth is enabled but credentials are missing.
// This prevents accidental unauthenticated production deployments.
if (config.auth && config.auth.enabled) {
  if (!config.auth.username || !config.auth.password) {
    console.error(
      "FATAL: AUTH_ENABLED=1 but AUTH_USERNAME/AUTH_PASSWORD are missing. Refusing to start.",
    );
    process.exit(1);
  }
}

const server = http.createServer(async (req, res) => {
  const startMs = Date.now();
  const host = req.headers.host || "localhost";

  // Generate or propagate a request id for easier tracing across logs/proxies.
  const requestId =
    (req.headers["x-request-id"] && String(req.headers["x-request-id"])) ||
    randomUUID();
  res.setHeader("X-Request-Id", requestId);

  let requestUrl;
  let pretty = false;

  try {
    setSecurityHeaders(res);
    setCors(req, res);

    // Handle CORS preflight quickly.
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Parse URL using Host header so relative request paths can be handled uniformly.
    requestUrl = new URL(req.url || "/", `http://${host}`);
    pretty = getPretty(requestUrl);

    const isHealth = isHealthPath(requestUrl.pathname);

    // During shutdown, keep health explicit and reject new work quickly.
    if (isShuttingDown) {
      if (isHealth) {
        return sendJson(
          res,
          503,
          {
            ok: false,
            shuttingDown: true,
            service: "HubSpot Recommendation Tool API",
          },
          pretty,
        );
      }

      return sendJson(
        res,
        503,
        { ok: false, error: "Server is shutting down. Please retry shortly." },
        pretty,
      );
    }

    // -------------------------
    // Lightweight authentication (optional)
    // -------------------------
    const authEnabled =
      config.auth.enabled &&
      typeof config.auth.username === "string" &&
      config.auth.username.length > 0 &&
      typeof config.auth.password === "string" &&
      config.auth.password.length > 0;

    // Gate everything (API + static) except health checks when configured.
    if (authEnabled && !(config.auth.allowHealth && isHealth)) {
      const ip = getClientIp(req);

      // Best-effort brute-force throttling (in-memory only).
      if (config.auth.rateLimit && config.auth.rateLimit.enabled) {
        const block = authRateLimiter.isBlocked(ip);
        if (block.blocked) {
          sendRateLimited(res, block.retryAfterSeconds, pretty);
          return;
        }
      }

      if (!isAuthorized(req, config.auth.username, config.auth.password)) {
        // Record failure and potentially block.
        if (config.auth.rateLimit && config.auth.rateLimit.enabled) {
          const block = authRateLimiter.recordFailure(ip);
          if (block.blocked) {
            sendRateLimited(res, block.retryAfterSeconds, pretty);
            return;
          }
        }

        sendAuthChallenge(res, config.auth.realm);
        return;
      }

      // Successful auth clears any accumulated failures for this IP.
      if (config.auth.rateLimit && config.auth.rateLimit.enabled) {
        authRateLimiter.recordSuccess(ip);
      }
    }

    // -------------------------
    // API routes
    // -------------------------
    if (req.method === "GET" && isHealthPath(requestUrl.pathname)) {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: "HubSpot Recommendation Tool API",
          shuttingDown: false,
        },
        pretty,
      );
      return;
    }

    if (req.method === "GET" && isAnalyzePath(requestUrl.pathname)) {
      await handleAnalyze(req, res, requestUrl);
      return;
    }

    // -------------------------
    // Static frontend (optional)
    // -------------------------
    if (config.static.enabled) {
      // 1) Serve existing built files directly (assets, favicon, manifest, etc.)
      const served = await tryServeStatic(req, res, requestUrl, {
        distDir: config.static.distDir,
        assetCacheSeconds: config.static.assetCacheSeconds,
      });
      if (served) return;

      // 2) SPA fallback for non-API GET requests.
      // Only fall back when the client likely expects HTML navigation.
      const accept = String(req.headers.accept || "");
      const looksLikeApi = requestUrl.pathname.startsWith("/api/");

      if (
        !looksLikeApi &&
        req.method === "GET" &&
        accept.includes("text/html")
      ) {
        const fellBack = await tryServeSpaFallback(req, res, {
          distDir: config.static.distDir,
        });
        if (fellBack) return;
      }
    }

    sendJson(res, 404, { ok: false, error: "Not found" }, pretty);
  } catch (err) {
    const safeMessage =
      config.env === "production"
        ? "Internal server error"
        : (err && (err.message || String(err))) || "Unknown error";

    sendJson(res, 500, { ok: false, error: safeMessage }, pretty);
  } finally {
    try {
      if (!requestUrl) {
        requestUrl = new URL(req.url || "/", `http://${host}`);
      }
      logRequest(req, res, requestUrl, requestId, startMs);
    } catch {
      // Ignore logging failures.
    }
  }
});

// --- Server hardening and lifecycle ---
// Production-safe HTTP timeouts / limits.
server.requestTimeout = config.http.requestTimeoutMs;
server.headersTimeout = config.http.headersTimeoutMs;
server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
server.maxRequestsPerSocket = config.http.maxRequestsPerSocket;

// Handle malformed/broken clients cleanly instead of noisy crashes.
server.on("clientError", (err, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  } catch {
    socket.destroy();
  }

  if (config.logging.requestLog) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "client_error",
        error: err?.message || String(err),
      }),
    );
  }
});

const port = config.port;

// Start the analysis thread now, so it loads the technology DB before the
// first request. A failed load is logged there and retried on the next request.
startAnalysisThread();

server.listen(port, "0.0.0.0", () => {
  console.log(`API listening on port ${port}`);
});

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received: starting graceful shutdown`);

  const forceCloseMs = 10_000;
  const timer = setTimeout(() => {
    console.error("Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, forceCloseMs);

  timer.unref();

  server.close((err) => {
    clearTimeout(timer);

    if (err) {
      console.error("Error while closing server:", err?.message || err);
      process.exit(1);
      return;
    }

    console.log("HTTP server closed");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
