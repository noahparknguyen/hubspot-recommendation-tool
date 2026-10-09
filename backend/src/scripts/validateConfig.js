#!/usr/bin/env node
// backend/src/scripts/validateConfig.js

const fs = require("node:fs/promises");
const path = require("node:path");
const { config } = require("../core/config");

async function main() {
  const errors = [];
  const warnings = [];

  // Basic env sanity
  if (
    !Number.isFinite(config.port) ||
    config.port <= 0 ||
    config.port > 65535
  ) {
    errors.push(`PORT must be a valid TCP port (got: ${config.port})`);
  }

  if (!Number.isFinite(config.fetch.timeoutMs) || config.fetch.timeoutMs <= 0) {
    errors.push(
      `FETCH_TIMEOUT_MS must be a positive integer (got: ${config.fetch.timeoutMs})`,
    );
  }

  if (!Number.isFinite(config.fetch.maxBytes) || config.fetch.maxBytes <= 0) {
    errors.push(
      `MAX_FETCH_BYTES must be a positive integer (got: ${config.fetch.maxBytes})`,
    );
  }

  if (
    !Number.isFinite(config.api.maxConcurrentAnalyses) ||
    config.api.maxConcurrentAnalyses <= 0
  ) {
    errors.push(
      `MAX_CONCURRENT_ANALYSES must be a positive integer (got: ${config.api.maxConcurrentAnalyses})`,
    );
  }

  if (
    !Number.isFinite(config.api.maxQueuedAnalyses) ||
    config.api.maxQueuedAnalyses < 0
  ) {
    errors.push(
      `MAX_QUEUED_ANALYSES must be zero or a positive integer (got: ${config.api.maxQueuedAnalyses})`,
    );
  }

  if (
    !Number.isFinite(config.api.queueTimeoutMs) ||
    config.api.queueTimeoutMs <= 0
  ) {
    errors.push(
      `ANALYSIS_QUEUE_TIMEOUT_MS must be a positive integer (got: ${config.api.queueTimeoutMs})`,
    );
  }

  if (
    !Number.isFinite(config.analysis.timeoutMs) ||
    config.analysis.timeoutMs <= 0
  ) {
    errors.push(
      `ANALYSIS_TIMEOUT_MS must be a positive integer (got: ${config.analysis.timeoutMs})`,
    );
  }

  if (
    !Number.isInteger(config.api.analyzeRateLimitPerHour) ||
    config.api.analyzeRateLimitPerHour < 0
  ) {
    errors.push(
      `ANALYZE_RATE_LIMIT_PER_HOUR must be zero or a positive integer (got: ${config.api.analyzeRateLimitPerHour})`,
    );
  }

  if (
    !Number.isInteger(config.http.trustProxyHops) ||
    config.http.trustProxyHops < 0
  ) {
    errors.push(
      `TRUST_PROXY_HOPS must be zero or a positive integer (got: ${config.http.trustProxyHops})`,
    );
  }

  if (
    !Number.isFinite(config.http.requestTimeoutMs) ||
    config.http.requestTimeoutMs <= 0
  ) {
    errors.push(
      `HTTP_REQUEST_TIMEOUT_MS must be a positive integer (got: ${config.http.requestTimeoutMs})`,
    );
  }

  if (
    !Number.isFinite(config.http.headersTimeoutMs) ||
    config.http.headersTimeoutMs <= 0
  ) {
    errors.push(
      `HTTP_HEADERS_TIMEOUT_MS must be a positive integer (got: ${config.http.headersTimeoutMs})`,
    );
  }

  if (
    Number.isFinite(config.http.headersTimeoutMs) &&
    Number.isFinite(config.http.requestTimeoutMs) &&
    config.http.headersTimeoutMs < config.http.requestTimeoutMs
  ) {
    errors.push(
      `HTTP_HEADERS_TIMEOUT_MS must be greater than or equal to HTTP_REQUEST_TIMEOUT_MS`,
    );
  }

  if (
    !Number.isFinite(config.http.keepAliveTimeoutMs) ||
    config.http.keepAliveTimeoutMs < 0
  ) {
    errors.push(
      `HTTP_KEEP_ALIVE_TIMEOUT_MS must be zero or a positive integer (got: ${config.http.keepAliveTimeoutMs})`,
    );
  }

  if (
    !Number.isFinite(config.http.maxRequestsPerSocket) ||
    config.http.maxRequestsPerSocket <= 0
  ) {
    errors.push(
      `HTTP_MAX_REQUESTS_PER_SOCKET must be a positive integer (got: ${config.http.maxRequestsPerSocket})`,
    );
  }

  // DATA_ROOT validation
  const root = config.dataRoot;
  if (!root || typeof root !== "string") {
    errors.push("DATA_ROOT is missing or invalid.");
  } else {
    await validateDataRoot(root, errors, warnings);
  }

  // Auth validation
  if (config.auth.enabled) {
    if (!config.auth.username) {
      errors.push("AUTH_ENABLED=1 requires AUTH_USERNAME to be set.");
    }
    if (!config.auth.password) {
      errors.push("AUTH_ENABLED=1 requires AUTH_PASSWORD to be set.");
    }
  }

  // Static build validation
  if (config.static.enabled) {
    await validateStaticDist(config.static.distDir, errors, warnings);
  }

  // Production posture warnings
  if (config.env === "production") {
    if (config.cors.allowOrigin === "*") {
      warnings.push(
        "CORS_ALLOW_ORIGIN=* in production is only appropriate for very limited public API scenarios.",
      );
    }

    if (!config.auth.enabled) {
      warnings.push(
        "AUTH_ENABLED=0 in production. This is only acceptable if access is restricted by another trusted layer.",
      );
    }
  }

  // Output
  if (warnings.length) {
    console.warn("⚠️  Config warnings:");
    for (const w of warnings) console.warn(" -", w);
  }

  if (errors.length) {
    console.error("❌ Config validation failed:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }

  console.log("✅ Config validation passed.");
  process.exit(0);
}

async function validateDataRoot(root, errors, warnings) {
  // Root must exist
  const exists = await pathExists(root);
  if (!exists) {
    errors.push(`DATA_ROOT does not exist: ${root}`);
    return;
  }

  // Required taxonomy files
  const categoriesPath = path.join(root, "categories.json");
  const groupsPath = path.join(root, "groups.json");
  if (!(await pathExists(categoriesPath)))
    errors.push(`Missing file: ${categoriesPath}`);
  if (!(await pathExists(groupsPath)))
    errors.push(`Missing file: ${groupsPath}`);

  // Technologies directory + expected files
  const techDir = path.join(root, "technologies");
  if (!(await pathExists(techDir))) {
    errors.push(`Missing directory: ${techDir}`);
    return;
  }

  const expected = technologyFiles(); // includes _.json + a..z
  const missing = [];
  for (const f of expected) {
    const p = path.join(techDir, f);
    if (!(await pathExists(p))) missing.push(f);
  }
  if (missing.length) {
    errors.push(
      `Missing technology JSON files in ${techDir}: ${missing.join(", ")}`,
    );
  }

  // Quick parse sanity (not exhaustive): ensure categories/groups are JSON
  await tryParseJson(categoriesPath, errors);
  await tryParseJson(groupsPath, errors);

  // Warn if tech dir contains unexpected JSON names (not an error — datasets evolve)
  const extra = await findExtraTechFiles(techDir, expected);
  if (extra.length) {
    warnings.push(
      `Technologies directory contains extra JSON files not in the explicit load list: ${extra.join(
        ", ",
      )}. This is OK, but they will NOT be loaded unless loadTechDb is updated.`,
    );
  }
}

async function validateStaticDist(distDir, errors, warnings) {
  if (!distDir || typeof distDir !== "string") {
    errors.push("STATIC_DIST_DIR is missing or invalid while SERVE_STATIC=1.");
    return;
  }

  const exists = await pathExists(distDir);
  if (!exists) {
    errors.push(`STATIC_DIST_DIR does not exist: ${distDir}`);
    return;
  }

  const indexPath = path.join(distDir, "index.html");
  if (!(await pathExists(indexPath))) {
    errors.push(`SERVE_STATIC=1 requires index.html at: ${indexPath}`);
  }

  const assetsDir = path.join(distDir, "assets");
  if (!(await pathExists(assetsDir))) {
    warnings.push(
      `No assets directory found at ${assetsDir}. This may be OK for some builds, but verify frontend output.`,
    );
  }
}

function technologyFiles() {
  const out = ["_.json"];
  for (let i = 0; i < 26; i++)
    out.push(String.fromCharCode("a".charCodeAt(0) + i) + ".json");
  return out;
}

async function findExtraTechFiles(dir, expected) {
  const exp = new Set(expected);
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".json"))
    .filter((n) => !exp.has(n))
    .sort((a, b) => a.localeCompare(b));
}

async function tryParseJson(filePath, errors) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    JSON.parse(raw);
  } catch (e) {
    errors.push(`Invalid JSON: ${filePath} (${e?.message || String(e)})`);
  }
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("❌ validateConfig crashed:", err?.message || err);
  process.exit(1);
});
