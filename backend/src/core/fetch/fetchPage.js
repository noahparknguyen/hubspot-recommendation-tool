// backend/src/core/fetch/fetchPage.js
const { URL } = require("node:url");
// undici's own fetch, not Node's global one: the Agent below comes from this
// package, and a dispatcher from one copy of undici isn't guaranteed to work
// with another copy's fetch.
const { Agent, fetch } = require("undici");
const { assertPublicHost, safeLookup } = require("./ssrf");
const { config } = require("../config");
const { AppError, isAppError } = require("../errors");

// Every connection resolves its host through safeLookup, so the address that
// passed the SSRF check is the address the socket connects to. A check in a
// separate lookup alone would let DNS answer the check and the connection
// differently.
const dispatcher = new Agent({ connect: { lookup: safeLookup } });

// One deadline covers a whole hop: the headers and the body alike.
function timeoutError(cause) {
  return new AppError({
    code: "FETCH_TIMEOUT",
    message: "Fetch timed out",
    statusCode: 504,
    expose: true,
    cause,
  });
}

/**
 * Read a response body with a soft cap: truncate at `maxBytes` rather than
 * throwing. The caller receives the partial content along with a `truncated`
 * flag so it can surface the limitation without failing the entire request.
 *
 * Why truncate instead of error?
 * - Large sites (e.g. Wix, Squarespace) may return responses exceeding 2 MB.
 *   A hard failure gives users a confusing error instead of a partial result.
 * - Technology detection is pattern-based and works well on the first portion
 *   of an HTML document (where `<head>` meta tags, inline scripts, and
 *   external resource references live).
 * - The frontend can optionally surface a "truncated" notice so users know
 *   results may be incomplete for unusually large pages.
 *
 * Uses Web Streams reader (Node's fetch/undici) to abort the connection
 * immediately once the cap is reached, avoiding unnecessary data transfer.
 *
 * @param {Response} res - Fetch API Response object
 * @param {{ maxBytes: number, controller: AbortController }} opts
 * @returns {Promise<{ buffer: Buffer, truncated: boolean }>}
 */
async function readBodyWithLimit(res, { maxBytes, controller }) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    throw new AppError({
      code: "FETCH_UNREADABLE_BODY",
      message: "Response body is not readable",
      statusCode: 502,
      expose: true,
    });
  }

  let received = 0;
  const chunks = [];
  let truncated = false;

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      // The deadline aborted the read. A server that sends its headers and then
      // trickles the body times out like one that never answers.
      if (controller.signal.aborted) throw timeoutError(err);
      throw err;
    }
    const { done, value } = chunk;
    if (done) break;

    const remaining = maxBytes - received;

    if (remaining <= 0) {
      // Cap already reached from a previous chunk — stop reading.
      truncated = true;
      try {
        controller.abort();
      } catch {
        // ignore — the connection may already be closed
      }
      break;
    }

    if (value.length > remaining) {
      // This chunk would push us over the limit — keep only what fits.
      chunks.push(value.subarray(0, remaining));
      received += remaining;
      truncated = true;
      try {
        controller.abort();
      } catch {
        // ignore
      }
      break;
    }

    received += value.length;
    chunks.push(value);
  }

  return { buffer: Buffer.concat(chunks), truncated };
}

async function discardBody(res) {
  try {
    await res.body?.cancel?.();
  } catch {
    // Already closed or errored: nothing left to release.
  }
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const v = String(x || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Finds every tag with the given name in one forward scan, so the work grows in
// step with the page. A regex such as /<script\b[^>]*\bsrc=…/ backtracks
// instead: a page of unclosed "<script " fragments takes minutes at the 2 MB
// cap, and the whole server waits.
function findTags(html, name) {
  const lower = html.toLowerCase();
  const open = `<${name}`;
  const tags = [];
  let i = 0;

  while ((i = lower.indexOf(open, i)) !== -1) {
    // "<scripts" is a different tag: the name must end here.
    const next = lower[i + open.length];
    if (next !== undefined && !/[\s/>]/.test(next)) {
      i += open.length;
      continue;
    }

    const end = lower.indexOf(">", i);
    if (end === -1) break; // nothing after this point can close a tag
    tags.push(html.slice(i, end + 1));
    i = end + 1;
  }

  return tags;
}

// Reads one attribute's value from a single tag: double-quoted, single-quoted,
// or unquoted.
function attribute(tag, name) {
  const m = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function extractExternalResources(html) {
  const scripts = [];
  for (const tag of findTags(html, "script")) {
    const src = attribute(tag, "src");
    if (src) scripts.push(src);
  }

  // A stylesheet link names "stylesheet" among its rel tokens, in any case and
  // in either attribute order.
  const styles = [];
  for (const tag of findTags(html, "link")) {
    const rel = (attribute(tag, "rel") || "").toLowerCase().split(/\s+/);
    const href = attribute(tag, "href");
    if (href && rel.includes("stylesheet")) styles.push(href);
  }

  return { scripts: uniq(scripts), styles: uniq(styles) };
}

function resolveUrls(urls, baseUrl) {
  const out = [];
  for (const u of urls) {
    const s = String(u || "").trim();
    if (!s) continue;

    // Skip obvious non-fetchable schemes
    if (/^(data|javascript|mailto):/i.test(s)) continue;

    try {
      const abs = new URL(s, baseUrl).toString();
      out.push(abs);
    } catch {
      // ignore invalid
    }
  }
  return uniq(out);
}

// --- Low-level fetch primitive with redirect-aware safety checks ---
/**
 * Fetch a single resource with SSRF checks per hop and a deadline.
 * Returns { finalUrl, status, statusText, headers, contentType, bytes, body }
 *
 * Important: we intentionally implement redirects manually:
 * - Node/undici can follow redirects automatically, but we need to re-check SSRF policy
 *   for every hop (hostname can change on redirects).
 */
async function fetchResource(
  resourceUrl,
  { deadlineMs, accept, userAgent, maxBytes, maxRedirects },
) {
  let currentUrl = resourceUrl;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) throw timeoutError();

    let urlObj;
    try {
      urlObj = new URL(currentUrl);
    } catch (err) {
      throw new AppError({
        code: "FETCH_INVALID_URL",
        message: "Invalid URL",
        statusCode: 400,
        expose: true,
        cause: err,
      });
    }

    if (!["http:", "https:"].includes(urlObj.protocol)) {
      throw new AppError({
        code: "FETCH_UNSUPPORTED_PROTOCOL",
        message: "Only http:// and https:// URLs are supported",
        statusCode: 400,
        expose: true,
      });
    }

    // SSRF checks must run on every hop because redirects can change hostname
    // after an initially safe URL is accepted.
    await assertPublicHost(urlObj.hostname);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), remainingMs);

    try {
      let res;
      try {
        res = await fetch(urlObj.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          dispatcher,
          headers: {
            "User-Agent": userAgent,
            Accept: accept,
          },
        });
      } catch (err) {
        if (err?.name === "AbortError") throw timeoutError(err);
        // safeLookup refused the address this connection resolved to.
        if (isAppError(err?.cause)) throw err.cause;

        throw new AppError({
          code: "FETCH_FAILED",
          message: "Fetch failed",
          statusCode: 502,
          expose: true,
          cause: err,
        });
      }

      // Manual redirect handling is intentional: automatic follow would skip our
      // per-hop host validation guarantees.
      if (
        [301, 302, 303, 307, 308].includes(res.status) &&
        res.headers.get("location")
      ) {
        // An unread body keeps its connection busy, so release it before the
        // next hop.
        await discardBody(res);

        if (redirects === maxRedirects) {
          throw new AppError({
            code: "FETCH_TOO_MANY_REDIRECTS",
            message: `Too many redirects (max ${maxRedirects})`,
            statusCode: 502,
            expose: true,
          });
        }

        const next = new URL(res.headers.get("location"), urlObj);

        if (!["http:", "https:"].includes(next.protocol)) {
          throw new AppError({
            code: "FETCH_REDIRECT_UNSUPPORTED_PROTOCOL",
            message: "Redirected to non-http(s) URL",
            statusCode: 502,
            expose: true,
          });
        }

        currentUrl = next.toString();
        continue;
      }

      const headers = {};
      for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;

      // Preserve all Set-Cookie headers when available (Node/undici extension)
      if (typeof res.headers.getSetCookie === "function") {
        headers["set-cookie"] = res.headers.getSetCookie();
      }

      // readBodyWithLimit returns { buffer, truncated }. The `truncated` flag is
      // true when the response body was cut off at maxBytes, so callers can
      // surface the partial result (e.g. add a notice in the API response).
      const { buffer, truncated } = await readBodyWithLimit(res, {
        maxBytes,
        controller,
      });

      return {
        finalUrl: currentUrl,
        status: res.status,
        statusText: res.statusText,
        headers,
        contentType: headers["content-type"] || "",
        bytes: buffer.length,
        body: buffer.toString("utf8"),
        // true when the response exceeded maxBytes and was cut at the cap
        truncated,
      };
    } finally {
      // Cleared only once the hop is over, so the deadline covers the body too.
      clearTimeout(timeoutId);
    }
  }

  throw new AppError({
    code: "FETCH_FAILED",
    message: "Fetch failed",
    statusCode: 502,
    expose: true,
  });
}

/**
 * Safe page fetch (Phase 2 in report):
 * - http/https only
 * - SSRF: blocks private/loopback/link-local targets
 * - deadline-based timeout
 * - max response size cap (soft: truncates instead of failing)
 * - redirect limit (enforces SSRF checks per hop)
 * - opportunistically fetches a bounded subset of external JS/CSS resources
 *
 * Why fetch external JS/CSS at all?
 * - Wappalyzer datasets often match technologies using inline code and static asset URLs.
 * - Pulling a *small* bounded subset improves detection coverage without becoming a crawler.
 *
 * Truncation behaviour (primary HTML document only):
 * - When the HTML response exceeds `maxBytes`, the body is cut at the cap rather
 *   than failing with an error. Technology detection is front-loaded in a page's
 *   <head> section (meta tags, inline scripts, external resource URLs), so a
 *   partial read usually yields accurate results.
 * - The return object includes `htmlTruncated: true` when this occurs so callers
 *   can surface a notice to the user (e.g. "results may be incomplete for this
 *   large page"). External scripts/stylesheets are fetched on a best-effort basis
 *   regardless — their individual caps remain hard (failures are swallowed).
 *
 * Boundaries here are intentionally strict (timeouts, redirect caps, byte caps, and
 * best-effort failures) so this endpoint remains safe to expose behind auth.
 *
 * @param {string} inputUrl - Target URL submitted by the user
 * @param {object} [options] - Optional runtime overrides for timeout and resource bounds
 * @returns {Promise<object>} Normalized fetch artifacts used by Phase 3 signal building.
 *   Includes `htmlTruncated: boolean` indicating whether the HTML body was cut at maxBytes.
 * @throws {Error} AppError variants for invalid URL, blocked host, timeout, or fetch failure.
 *   Note: an oversized HTML response is no longer an error — it is truncated and returned.
 */
async function fetchPage(inputUrl, options = {}) {
  const {
    timeoutMs = config.fetch.timeoutMs,
    maxBytes = config.fetch.maxBytes,
    userAgent = "HubSpot-Recommendation-Tool/1.0 (+internal tech detector)",
    maxRedirects = 5,

    // External resources (bounded, best-effort)
    maxExternalScripts = 8,
    maxExternalStylesheets = 8,
    maxExternalBytesEach = 250_000,
    maxExternalBytesTotal = 800_000,
    maxExternalConcurrency = 4,
  } = options;

  const start = Date.now();
  const deadlineMs = start + timeoutMs;

  // Fetch the primary HTML document
  let page;
  try {
    page = await fetchResource(inputUrl, {
      deadlineMs,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      userAgent,
      maxBytes,
      maxRedirects,
    });
  } catch (err) {
    if (err && err.name === "AppError") throw err;
    throw new AppError({
      code: "FETCH_FAILED",
      message: "Fetch failed",
      statusCode: 502,
      expose: true,
      cause: err,
    });
  }

  const headers = page.headers || {};
  const html = page.body || "";
  const baseUrl = page.finalUrl;
  // Propagate truncation flag: true when the HTML body was cut at maxBytes.
  // External resources are fetched independently and swallow their own errors.
  const htmlTruncated = page.truncated === true;

  // Pulling some external assets improves detection coverage, but we keep strict
  // byte/count/concurrency limits so this never behaves like a crawler.
  // (keeps matchers effective while bounding latency and bytes).
  const ext = extractExternalResources(html);

  const scriptUrls = resolveUrls(ext.scripts, baseUrl).slice(
    0,
    maxExternalScripts,
  );
  const styleUrls = resolveUrls(ext.styles, baseUrl).slice(
    0,
    maxExternalStylesheets,
  );

  const external = {
    scripts: [],
    stylesheets: [],
    skipped: {
      scripts: Math.max(0, ext.scripts.length - scriptUrls.length),
      stylesheets: Math.max(0, ext.styles.length - styleUrls.length),
    },
  };

  let externalBytesBudget = maxExternalBytesTotal;

  async function mapLimit(items, limit, fn) {
    const out = [];
    let i = 0;

    const workers = new Array(Math.min(limit, items.length))
      .fill(null)
      .map(async () => {
        while (true) {
          const idx = i++;
          if (idx >= items.length) return;
          const val = await fn(items[idx]);
          if (val) out.push(val);
        }
      });

    await Promise.all(workers);
    return out;
  }

  async function fetchExternal(url, accept) {
    // If we're out of budget or time, skip
    if (externalBytesBudget <= 0) return null;
    if (Date.now() >= deadlineMs) return null;

    // Per-resource cap + global cap
    const cap = Math.min(maxExternalBytesEach, externalBytesBudget);

    try {
      const r = await fetchResource(url, {
        deadlineMs,
        accept,
        userAgent,
        maxBytes: cap,
        maxRedirects,
      });

      externalBytesBudget -= r.bytes;

      return {
        url: r.finalUrl,
        bytes: r.bytes,
        contentType: r.contentType,
        body: r.body,
      };
    } catch {
      return null;
    }
  }

  const [scriptBodies, styleBodies] = await Promise.all([
    mapLimit(scriptUrls, maxExternalConcurrency, (u) =>
      fetchExternal(u, "application/javascript,text/javascript,*/*;q=0.8"),
    ),
    mapLimit(styleUrls, maxExternalConcurrency, (u) =>
      fetchExternal(u, "text/css,*/*;q=0.8"),
    ),
  ]);

  external.scripts = scriptBodies.filter(Boolean);
  external.stylesheets = styleBodies.filter(Boolean);

  const end = Date.now();

  return {
    ok: true,
    requestedUrl: inputUrl,
    finalUrl: baseUrl,
    status: page.status,
    statusText: page.statusText || "",
    headers,
    contentType: headers["content-type"] || page.contentType || "",
    bytes: Buffer.byteLength(html, "utf8"),
    timingMs: end - start,

    // Primary document
    html,

    // true when the HTML body was cut at maxBytes (soft cap).
    // Callers should surface this to the user when present so they know
    // detection results may be incomplete for unusually large pages.
    htmlTruncated,

    // Additional artifacts used by buildSignals (Phase 3)
    external,
  };
}

module.exports = { fetchPage };
