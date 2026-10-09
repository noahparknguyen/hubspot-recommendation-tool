const path = require("path");

// --- Environment coercion helpers ---
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, fallback) {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function bool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).toLowerCase().trim();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return fallback;
}

// --- Centralized runtime configuration ---
// Parse once at process startup so all modules share consistent defaults and coercion behavior.
const config = {
  port: num(process.env.PORT, 3001),

  // Resolved from process working directory at startup.
  // Default is relative to backend/ when run via npm scripts; override with an absolute path in Docker.
  dataRoot: path.resolve(
    process.cwd(),
    str(process.env.DATA_ROOT, "./data/vendor/webappanalyzer/src"),
  ),

  fetch: {
    timeoutMs: num(process.env.FETCH_TIMEOUT_MS, 12_000),
    maxBytes: num(process.env.MAX_FETCH_BYTES, 2_000_000),
  },

  analysis: {
    // Time limit for detecting a fetched page's technologies. Some dataset
    // patterns backtrack badly on crafted pages. Past this, the analysis is
    // stopped and the request gets a 504. It's generous because large real
    // pages are slow on a small server: a 2 MB article takes over a minute
    // on a tenth of a CPU.
    timeoutMs: num(process.env.ANALYSIS_TIMEOUT_MS, 60_000),
  },

  env: str(process.env.NODE_ENV, "development"),

  logging: {
    // Enable request log lines (JSON) in prod when needed.
    requestLog: bool(process.env.REQUEST_LOG, false),
  },

  cors: {
    // "*" for simple dev; set to a specific origin for production hardening if desired.
    // Set to "off" to disable CORS headers entirely.
    allowOrigin: str(process.env.CORS_ALLOW_ORIGIN, "*"),
  },

  static: {
    // When enabled, the API server will also serve a built Vite/React frontend.
    // Typically you enable this in production (SERVE_STATIC=1) and point STATIC_DIST_DIR
    // at the Vite build output directory.
    enabled: bool(process.env.SERVE_STATIC, false),
    // Path to built frontend assets; resolved from process working directory at startup.
    distDir: path.resolve(
      process.cwd(),
      str(process.env.STATIC_DIST_DIR, "./public"),
    ),
    // Basic caching: in production, immutable hashed assets can be cached longer.
    // (index.html is always served with no-store.)
    assetCacheSeconds: num(
      process.env.STATIC_ASSET_CACHE_SECONDS,
      60 * 60 * 24 * 30,
    ),
  },

  api: {
    // Concurrency guardrail to prevent resource exhaustion from many long-running fetches.
    // If the limit is reached, /analyze returns 503 with a retryable message.
    maxConcurrentAnalyses: num(process.env.MAX_CONCURRENT_ANALYSES, 8),
    // Reject requests when the wait queue exceeds this size (keeps memory bounded).
    maxQueuedAnalyses: num(process.env.MAX_QUEUED_ANALYSES, 32),
  },

  auth: {
    // Lightweight HTTP Basic Auth gate.
    // IMPORTANT: Only meaningful over HTTPS.
    enabled: bool(process.env.AUTH_ENABLED, false),
    username: str(process.env.AUTH_USERNAME, ""),
    password: str(process.env.AUTH_PASSWORD, ""),
    realm: str(process.env.AUTH_REALM, "Internal Tool"),
    // Keep health endpoint open so container/orchestrator probes work.
    allowHealth: bool(process.env.AUTH_ALLOW_HEALTH, true),

    rateLimit: {
      // Rate limit failed auth attempts (best-effort; in-memory).
      enabled: bool(process.env.AUTH_RATE_LIMIT_ENABLED, true),
      windowMs: num(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 60_000),
      maxFailures: num(process.env.AUTH_RATE_LIMIT_MAX_FAILURES, 12),
      blockMs: num(process.env.AUTH_RATE_LIMIT_BLOCK_MS, 300_000),
    },
  },

  http: {
    // Protect against slow/stalled clients and overly long-lived sockets.
    requestTimeoutMs: num(process.env.HTTP_REQUEST_TIMEOUT_MS, 30_000),
    headersTimeoutMs: num(process.env.HTTP_HEADERS_TIMEOUT_MS, 35_000),
    keepAliveTimeoutMs: num(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 5_000),
    maxRequestsPerSocket: num(process.env.HTTP_MAX_REQUESTS_PER_SOCKET, 100),
  },

  // Internal-only debug
  debugSignals: bool(process.env.DEBUG_SIGNALS, false),
};

module.exports = { config };
