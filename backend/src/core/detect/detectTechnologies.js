// backend/src/core/detect/detectTechnologies.js

const { matchCookies } = require("./matchers/cookies");
const { matchHeaders } = require("./matchers/headers");
const { matchHtml } = require("./matchers/html");
const { matchMeta } = require("./matchers/meta");
const { matchScriptSrc } = require("./matchers/scriptSrc");
const { matchScripts } = require("./matchers/scripts");
const { matchCss } = require("./matchers/css");
const { matchText } = require("./matchers/text");
const { matchUrl } = require("./matchers/url");
const { matchDom } = require("./matchers/dom");

const { resolveRequires } = require("./resolve/requires");
const { resolveImplies } = require("./resolve/implies");
const { resolveExcludes } = require("./resolve/excludes");

/**
 * Phase 4 (Technology Detection): detect technologies by matching patterns across 10 matcher types.
 *
 * Report invariants:
 * - Each matcher yields confidence 0..100
 * - Confidence is aggregated across matchers
 * - Filter out detections below minConfidence (default 50)
 * - Apply implies/requires relationships
 *
 * Why matchers are defensive/no-throw:
 * - vendor datasets can contain unexpected shapes and occasional invalid regexes
 * - a single bad rule should reduce coverage for that technology, not fail the entire request
 *
 * @param {object} db - Loaded technology database and matcher index
 * @param {object} signals - Normalized signal bundle from Phase 3
 * @param {{ minConfidence?: number }} [options] - Detection threshold overrides
 * @returns {Array<object>} Stable, filtered list of detected technologies
 * @throws {Error} If database was not initialized before detection
 */
function detectTechnologies(db, signals, options = {}) {
  const { minConfidence = 50 } = options;

  if (!db || !db.technologies) {
    throw new Error("Tech DB is not loaded");
  }

  // slug -> { slug, name, confidence, version, _versionBestConf, evidence[] }
  const detections = new Map();

  // Run order is fixed for deterministic debugging output and reproducible tests.
  // It does not change semantic correctness because aggregation is commutative.
  // The DB provides a lightweight index per signal type so we don't scan every technology for
  // every matcher when the vendor dataset includes only a subset of rules.
  runMatcher(detections, matchUrl, db, signals);
  runMatcher(detections, matchHeaders, db, signals);
  runMatcher(detections, matchCookies, db, signals);
  runMatcher(detections, matchMeta, db, signals);
  runMatcher(detections, matchHtml, db, signals);
  runMatcher(detections, matchText, db, signals);
  runMatcher(detections, matchScriptSrc, db, signals);
  runMatcher(detections, matchScripts, db, signals);
  runMatcher(detections, matchCss, db, signals);
  runMatcher(detections, matchDom, db, signals);

  let found = Array.from(detections.values()).map(finalizeDetection);

  // Relationship resolution order is intentional:
  // 1) requires removes detections missing prerequisites,
  // 2) implies adds inferred technologies,
  // 3) excludes resolves mutually incompatible detections.
  // Running requires first reduces false-positive propagation into implied results.
  found = resolveRequires(found, db);
  found = resolveImplies(found, db);
  found = resolveExcludes(found, db); // vendor-compat extension

  // Threshold is applied after relationship logic so implied detections can still
  // contribute when they clear confidence policy.
  found = found.filter((d) => (d.confidence || 0) >= minConfidence);

  // Stable order (confidence desc, slug asc)
  found.sort((a, b) => {
    if ((b.confidence || 0) !== (a.confidence || 0))
      return (b.confidence || 0) - (a.confidence || 0);
    return (a.slug || "").localeCompare(b.slug || "");
  });

  return found;
}

// --- Matcher execution and aggregation helpers ---
function runMatcher(detections, matcherFn, db, signals) {
  try {
    const matches = matcherFn(db, signals);
    if (!Array.isArray(matches)) return;

    for (const m of matches) {
      if (!m || !m.slug) continue;

      const slug = String(m.slug);
      const tech = db.technologies[slug];
      if (!tech) continue;

      const incomingConf = clampConfidence(m.confidence);
      const existing = detections.get(slug) || {
        slug,
        name: tech.name || slug,
        confidence: 0,
        version: undefined,
        _versionBestConf: -1,
        evidence: [],
      };

      // Probabilistic OR keeps confidence bounded while rewarding multiple independent signals.
      existing.confidence = aggregateConfidence(
        existing.confidence,
        incomingConf,
      );

      // Prefer version from the single strongest evidence match
      if (m.version && typeof m.version === "string") {
        if (incomingConf > (existing._versionBestConf ?? -1)) {
          existing._versionBestConf = incomingConf;
          existing.version = m.version;
        }
      }

      if (m.evidence) {
        const ev = String(m.evidence).trim();
        if (ev) existing.evidence.push(ev);
      }

      detections.set(slug, existing);
    }
  } catch (err) {
    // A matcher should never take down the pipeline. But a matcher that
    // throws loses every detection of its kind, so say which one, or the
    // results just get thinner with nothing in the logs to explain why.
    console.warn(
      `[detect] ${matcherFn.name} threw; its detections were skipped:`,
      err,
    );
  }
}

/**
 * Aggregate confidence scores from multiple matchers.
 *
 * Uses probabilistic OR:
 *   combined = 1 - (1-a)*(1-b)  where a,b in [0,1]
 *
 * Benefits:
 * - stays in [0,100]
 * - multiple independent weak signals compound
 * - diminishing returns prevents runaway sums
 */
function aggregateConfidence(current, incoming) {
  const a = clampConfidence(current) / 100;
  const b = clampConfidence(incoming) / 100;
  const combined = 1 - (1 - a) * (1 - b);
  return clampConfidence(combined * 100);
}

function finalizeDetection(d) {
  const out = {
    slug: d.slug,
    name: d.name,
    confidence: clampConfidence(d.confidence),
  };
  if (d.version) out.version = d.version;

  if (Array.isArray(d.evidence) && d.evidence.length) {
    out.evidence = dedupe(d.evidence).slice(0, 20);
  }

  return out;
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const s = String(v || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function clampConfidence(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 100) return 100;
  return Math.round(x);
}

module.exports = { detectTechnologies };
