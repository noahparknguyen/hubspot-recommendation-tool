const { analyzeUrl } = require("../../core/analyzer");
// buildFrontendReport produces a slimmed response containing only the fields
// consumed by the React frontend. buildSimpleReport (full shape) is kept for
// CLI and any other internal consumers — this route no longer uses it directly.
const { buildFrontendReport } = require("../../core/report/cleanReport");
const { isAppError } = require("../../core/errors");
const { analysisLimiter } = require("../analysisLimiter");
const { createRateLimiter } = require("../rateLimit");
const { getClientIp } = require("../clientIp");
const { config } = require("../../core/config");

// Optional per-client limit, off unless ANALYZE_RATE_LIMIT_PER_HOUR is set.
// It reuses the failed-login limiter, counting each analysis as an event:
// past the hourly maximum, the client is blocked for an hour.
const HOUR_MS = 60 * 60 * 1000;
const analyzeRateLimiter =
  config.api.analyzeRateLimitPerHour > 0
    ? createRateLimiter({
        windowMs: HOUR_MS,
        maxFailures: config.api.analyzeRateLimitPerHour,
        blockMs: HOUR_MS,
      })
    : null;

// This route is intentionally "thin":
// - it validates inputs and applies back-pressure (the optional per-client
//   limit, then analysisLimiter)
// - it delegates the heavy lifting to core/analyzer (shared by API + CLI)
// - it shapes output via buildFrontendReport (slimmed, frontend-only contract)

// Serialises `payload` to compact JSON (no whitespace indentation).
// The `pretty` parameter is intentionally removed — the frontend does not
// need human-readable JSON from this endpoint, and compact output reduces
// response size and serialisation overhead.
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function sendRateLimited(res, retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  return sendJson(res, 429, {
    ok: false,
    error: `Analysis limit reached. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    retryAfterSeconds,
  });
}

function normalizeAndValidateUrl(raw) {
  if (typeof raw !== "string")
    return { ok: false, error: "Missing or invalid 'url' in query string" };

  const trimmed = raw.trim();
  if (!trimmed)
    return { ok: false, error: "Missing or invalid 'url' in query string" };

  // Hard cap to avoid abuse
  if (trimmed.length > 2048) return { ok: false, error: "URL is too long" };

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are supported" };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * GET /analyze
 *
 * Slimmed response intended for frontend display. Only fields consumed by the
 * React frontend are included (ok, url, finalUrl, technologies, htmlTruncated).
 * See buildFrontendReport in cleanReport.js for the full field list.
 *
 * The `pretty` and `includeMeta` query params accepted by earlier versions of
 * this route have been removed:
 * - `pretty` caused the backend to JSON.stringify with 2-space indentation,
 *   adding significant whitespace overhead on every response. The frontend
 *   never needed human-readable JSON from this endpoint.
 * - `includeMeta` is not relevant for the slimmed frontend shape; diagnostic
 *   metadata (timings, fetch headers) is still available via buildCleanReport
 *   which is used by the CLI.
 *
 * Query params:
 * - url (required) — absolute http/https URL to analyze
 *
 * @param {import("node:http").IncomingMessage} req - Raw incoming request object, for the client's address
 * @param {import("node:http").ServerResponse} res - Response writer
 * @param {URL} requestUrl - Parsed request URL with query params
 * @returns {Promise<void>} Resolves after response is written
 */
async function handleAnalyze(req, res, requestUrl) {
  const rawUrl = requestUrl.searchParams.get("url");

  const normalized = normalizeAndValidateUrl(rawUrl);
  if (!normalized.ok) {
    return sendJson(res, 400, {
      ok: false,
      error: normalized.error,
      example: "/analyze?url=https://react.dev/",
    });
  }

  // Only requests that would run an analysis count. A blocked request isn't
  // counted, so retrying doesn't extend the block.
  if (analyzeRateLimiter) {
    const ip = getClientIp(req);
    let block = analyzeRateLimiter.isBlocked(ip);
    if (!block.blocked) block = analyzeRateLimiter.recordFailure(ip);
    if (block.blocked) return sendRateLimited(res, block.retryAfterSeconds);
  }

  try {
    // Back-pressure guardrail:
    // analysis includes outbound fetches and regex matching; without a limiter, parallel requests
    // can degrade the service or trigger upstream blocking. This keeps concurrency bounded and
    // provides a clear retryable failure mode upstream (503 in limiter implementation).
    //
    // A visitor who leaves while queued gives up their place, rather than
    // costing a full analysis nobody will see. "close" also fires after a
    // normal response, which writableFinished tells apart.
    const visitorLeft = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) visitorLeft.abort();
    });
    const release = await analysisLimiter.acquire(visitorLeft.signal);
    try {
      const report = await analyzeUrl(normalized.url);
      // buildFrontendReport strips all fields not consumed by the React frontend,
      // reducing response size. The full shape is available via buildSimpleReport
      // or buildCleanReport for CLI/internal use.
      const response = buildFrontendReport(report);
      return sendJson(res, 200, response);
    } finally {
      release();
    }
  } catch (err) {
    // Map operational errors to their intended status code.
    if (isAppError(err)) {
      return sendJson(res, err.statusCode, {
        ok: false,
        error: err.expose ? err.message : "Request failed",
      });
    }

    const safeMessage =
      config.env === "production"
        ? "Internal server error"
        : (err && (err.message || String(err))) || "Unknown error";

    return sendJson(res, 500, { ok: false, error: safeMessage });
  }
}

module.exports = { handleAnalyze };
