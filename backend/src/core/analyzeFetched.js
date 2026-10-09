// backend/src/core/analyzeFetched.js
//
// The CPU-bound half of an analysis: everything after the page is fetched.
// It runs on the analysis worker thread (see worker/runAnalysis.js), where a
// page that makes a dataset pattern backtrack can be stopped.
const { buildSignals } = require("./normalize/signals");
const { loadTechDb } = require("./techdb/loadTechDb");
const { detectTechnologies } = require("./detect/detectTechnologies");
const { enrichDetections } = require("./report/enrichDetections");
const { buildRecommendations } = require("./report/recommendations");
const { buildSummary } = require("./report/summarize");
const { groupDetections } = require("./report/groupDetections");
const { config } = require("./config");

const MIN_CONFIDENCE = 50; // report-aligned threshold

let cachedDb = null;
let dbInitPromise = null;

// --- Phase 1 bootstrap: dataset cache ---
/**
 * Loads and caches the technology database for the current thread.
 * Reuses the same in-memory object for all analyses to avoid disk IO on every one.
 *
 * @returns {Promise<object>} Loaded technology database object from `loadTechDb()`
 */
async function initTechDb() {
  if (cachedDb) return cachedDb;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const db = await loadTechDb();
      cachedDb = db;
      return db;
    })().finally(() => {
      // Allow retry on failure:
      // - on a transient filesystem issue, the next request can attempt re-init
      // - on success, cachedDb is set and dbInitPromise becomes irrelevant
      if (!cachedDb) {
        console.error(
          "[analyzer] Tech DB failed to load; will retry on next request.",
        );
        dbInitPromise = null;
      }
    });
  }
  return dbInitPromise;
}

// --- Phases 3-5 ---
/**
 * Turns a fetched page into detections, recommendations, and their summaries.
 *
 * @param {object} db - Technology database from `initTechDb()`
 * @param {object} fetched - Result of `fetchPage()`
 * @returns {{detections: object[], recommendations: object[], summary: object, groups: object, debugSignals: (object|undefined)}}
 *   Detections are sorted by confidence desc, then name asc. `debugSignals` is set only when `config.debugSignals` is on.
 */
function analyzeFetched(db, fetched) {
  // Phase 3: normalize to stable signals so matchers operate over consistent inputs.
  const signals = buildSignals(fetched);

  // Optional internal-only debug signals (never required for frontend output)
  const debugSignals = config.debugSignals
    ? {
        metaKeys: Object.keys(signals.meta || {}).slice(0, 50),
        scriptSrcPreview: (signals.scriptSrc || []).slice(0, 20),
        cookieNames: Array.isArray(signals.cookies) ? signals.cookies : [],
      }
    : undefined;

  // Phase 4: run Wappalyzer-style matchers across multiple signal types (headers, DOM, etc.)
  const detections = detectTechnologies(db, signals, {
    minConfidence: MIN_CONFIDENCE,
  });
  // Phase 5: attach taxonomy + human-friendly metadata (used by report + recommendation logic)
  const enriched = enrichDetections(db, detections);

  // Keep output ordering deterministic so repeated runs are stable and diff-friendly.
  // Stable ordering: confidence desc, then name asc
  enriched.sort((a, b) => {
    if ((b.confidence || 0) !== (a.confidence || 0))
      return (b.confidence || 0) - (a.confidence || 0);
    return (a.name || "").localeCompare(b.name || "");
  });

  const summary = buildSummary(enriched);
  const groups = groupDetections(enriched);

  // Keep recommendations consistent with the report’s detection threshold unless a stricter value is explicitly desired.
  const recommendations = buildRecommendations(enriched, {
    minConfidence: MIN_CONFIDENCE,
  });

  return {
    detections: enriched,
    recommendations,
    summary,
    groups,
    debugSignals,
  };
}

module.exports = { analyzeFetched, initTechDb };
