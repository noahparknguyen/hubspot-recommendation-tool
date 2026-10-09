// backend/src/core/analyzer.js
//
// High-level analysis pipeline (used by both API + CLI):
// 1) Fetch (SSRF-guarded, size/time bounded, redirect-checked per hop)
// 2) Normalize into "signals" (bounded strings + structured artifacts)
// 3) Pattern-match those signals against the local WebAppAnalyzer/Wappalyzer-style dataset
// 4) Enrich detections with taxonomy metadata
// 5) Generate HubSpot recommendations and build the UI-oriented report shape
//
// This file intentionally keeps the orchestration simple and stable:
// - steps 2-5 run on the analysis worker thread, under a time limit (worker/runAnalysis.js)
// - that thread loads the dataset once and caches it
// - analysis is deterministic for a given fetch result + dataset
const { fetchPage } = require("./fetch/fetchPage");
const { runAnalysis } = require("./worker/runAnalysis");

// --- Phases 2-5 orchestration entrypoint ---
/**
 * Runs the full analysis pipeline for a single URL and returns the API report payload.
 *
 * @param {string} url - Absolute http/https URL to analyze
 * @returns {Promise<object>} Full analysis report with fetch metadata, detections, and recommendations.
 *   Includes `htmlTruncated: boolean` when the HTML body was cut at the configured byte cap
 *   (see fetchPage). Report consumers (e.g. buildFrontendReport) forward this flag to callers.
 * @throws {Error} Propagates operational errors from fetch, normalization, detection, or report stages,
 *   and a 504 AppError when phases 3-5 run past `config.analysis.timeoutMs`
 */
async function analyzeUrl(url) {
  const totalStart = Date.now();

  // Phase 2: fetch the primary HTML and a bounded subset of external JS/CSS.
  // External resources are best-effort and exist to improve detection coverage without
  // allowing the analyzer to become an unbounded crawler.
  const fetched = await fetchPage(url);
  const fetchMs = fetched.timingMs;

  const analysisStart = Date.now();

  // Phases 3-5 (see analyzeFetched.js), on the analysis thread.
  const { detections, recommendations, summary, groups, debugSignals } =
    await runAnalysis(fetched);

  const analysisMs = Date.now() - analysisStart;
  const totalMs = Date.now() - totalStart;

  const report = {
    ok: true,
    url,
    finalUrl: fetched.finalUrl,

    // Propagated from fetchPage: true when the HTML body was cut at the byte
    // cap. buildFrontendReport forwards this to the API response so the
    // frontend can optionally surface a "results may be incomplete" notice.
    htmlTruncated: fetched.htmlTruncated === true,

    fetch: {
      status: fetched.status,
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      timingMs: fetchMs,
      headers: pickHeaders(fetched.headers, [
        "server",
        "x-powered-by",
        "via",
        "cf-ray",
        "cf-cache-status",
        "x-vercel-cache",
        "x-vercel-id",
        "x-served-by",
        "x-cache",
        "set-cookie",
      ]),
    },
    timings: {
      analysisMs,
      totalMs,
    },
    detections,
    recommendations,
    summary,
    groups,
  };

  if (debugSignals) report._debugSignals = debugSignals;

  return report;
}

// --- Response shaping helpers ---
function pickHeaders(headers, keys) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;

  for (const k of keys) {
    if (headers[k] != null) out[k] = headers[k];
  }
  return out;
}

module.exports = { analyzeUrl };
