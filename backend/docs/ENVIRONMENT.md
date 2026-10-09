# Environment Variables

This document lists every backend environment variable defined in `src/core/config.js`, including type, default, usage, and misconfiguration impact.

## Required vs Optional

- Required only when auth is enabled:
  - `AUTH_USERNAME`
  - `AUTH_PASSWORD`
- All other variables have code defaults

## Variables

### `PORT`

- Type: number
- Default: `3001`
- Purpose: HTTP listen port
- Misconfigured impact: invalid port can prevent startup or bind behavior

### `DATA_ROOT`

- Type: path string
- Default: `./data/vendor/webappanalyzer/src` (resolved from process cwd)
- Purpose: location of the WebAppAnalyzer fingerprint dataset (enthec, GPL-3.0 — see root `NOTICE`)
- Misconfigured impact:
  - DB load fails
  - analysis fails when DB cannot initialize
  - `validate-config` will fail if path/files missing

### `FETCH_TIMEOUT_MS`

- Type: number
- Default: `12000`
- Purpose: wall-clock deadline for fetch operations
- Misconfigured impact:
  - too low: false timeout failures (`504`)
  - too high: longer resource hold under slow targets

### `ANALYSIS_TIMEOUT_MS`

- Type: number
- Default: `60000`
- Purpose: time limit for detecting a fetched page's technologies, on the
  analysis thread. Past it, the analysis is stopped and the request gets a
  `504`. Large real pages are slow on a small server: a 2 MB article takes over
  a minute on a tenth of a CPU, so keep this generous there.
- Misconfigured impact:
  - too low: large legitimate pages fail with `504`
  - too high: a page crafted to be slow holds the analysis thread longer,
    delaying the analyses queued behind it

### `MAX_FETCH_BYTES`

- Type: number
- Default: `2000000`
- Purpose: max primary response body bytes (soft cap — the body is truncated
  at this limit and the response carries `htmlTruncated: true`; it does not
  return an error)
- Misconfigured impact:
  - too low: frequent truncation, incomplete detection results
  - too high: higher memory pressure

### `NODE_ENV`

- Type: string
- Default: `development`
- Purpose: production vs development behavior (mainly error detail exposure)
- Misconfigured impact: can expose too much error detail or hide useful debug info

### `REQUEST_LOG`

- Type: boolean-like (`1/0`, `true/false`, `yes/no`, `on/off`)
- Default: `false`
- Purpose: enable JSON request logs
- Misconfigured impact: logging noise or missing request traces

### `CORS_ALLOW_ORIGIN`

- Type: string
- Default: `*`
- Purpose: CORS allow origin policy
- Special value: `off` disables CORS headers
- Misconfigured impact:
  - too strict: browser calls fail in split-origin dev
  - too open: unnecessary cross-origin exposure

### `SERVE_STATIC`

- Type: boolean-like
- Default: `false`
- Purpose: enable static frontend serving from backend
- Misconfigured impact: integrated UI not served when expected

### `STATIC_DIST_DIR`

- Type: path string
- Default: `./public` (resolved from process cwd)
- Purpose: path to built frontend assets
- Misconfigured impact: static files and SPA fallback fail

### `STATIC_ASSET_CACHE_SECONDS`

- Type: number
- Default: `2592000` (30 days)
- Purpose: immutable cache duration for hashed assets
- Misconfigured impact: stale assets or reduced cache efficiency

### `MAX_CONCURRENT_ANALYSES`

- Type: number
- Default: `8`
- Purpose: max simultaneous analyses
- Misconfigured impact:
  - too low: unnecessary throttling
  - too high: CPU/socket pressure

### `MAX_QUEUED_ANALYSES`

- Type: number
- Default: `32`
- Purpose: max queued analysis requests
- Misconfigured impact:
  - too low: more `503 ANALYZE_OVERLOADED`
  - too high: memory pressure under bursts

### `AUTH_ENABLED`

- Type: boolean-like
- Default: `false`
- Purpose: enable HTTP Basic Auth gate
- Misconfigured impact: either unexpected access denial or unintended open access

### `AUTH_USERNAME`

- Type: string
- Default: empty string
- Purpose: Basic Auth username
- Required when: `AUTH_ENABLED=1`
- Misconfigured impact: startup exits if auth enabled and missing

### `AUTH_PASSWORD`

- Type: string
- Default: empty string
- Purpose: Basic Auth password
- Required when: `AUTH_ENABLED=1`
- Misconfigured impact: startup exits if auth enabled and missing

### `AUTH_REALM`

- Type: string
- Default: `Internal Tool`
- Purpose: browser challenge realm text
- Misconfigured impact: cosmetic login prompt confusion

### `AUTH_ALLOW_HEALTH`

- Type: boolean-like
- Default: `true`
- Purpose: bypass auth on `/health` and `/api/health`
- Misconfigured impact: health probes may fail with `401`

### `AUTH_RATE_LIMIT_ENABLED`

- Type: boolean-like
- Default: `true`
- Purpose: enable failed-auth in-memory limiter
- Misconfigured impact: brute-force throttling disabled if off

### `AUTH_RATE_LIMIT_WINDOW_MS`

- Type: number
- Default: `60000`
- Purpose: failure counting window
- Misconfigured impact: too short/long block sensitivity

### `AUTH_RATE_LIMIT_MAX_FAILURES`

- Type: number
- Default: `12`
- Purpose: max failures before block
- Misconfigured impact: too low locks users quickly; too high weakens protection

### `AUTH_RATE_LIMIT_BLOCK_MS`

- Type: number
- Default: `300000`
- Purpose: block duration after threshold
- Misconfigured impact: overly long or ineffective block periods

### `HTTP_REQUEST_TIMEOUT_MS`

- Type: number
- Default: `30000`
- Purpose: server request timeout
- Misconfigured impact: stalled connections or premature termination

### `HTTP_HEADERS_TIMEOUT_MS`

- Type: number
- Default: `35000`
- Purpose: server headers timeout
- Misconfigured impact: if less than request timeout, config validation fails

### `HTTP_KEEP_ALIVE_TIMEOUT_MS`

- Type: number
- Default: `5000`
- Purpose: socket keep-alive timeout
- Misconfigured impact: connection churn or excess open sockets

### `HTTP_MAX_REQUESTS_PER_SOCKET`

- Type: number
- Default: `100`
- Purpose: max requests per keep-alive socket
- Misconfigured impact: poor socket reuse or long-lived socket risk

### `DEBUG_SIGNALS`

- Type: boolean-like
- Default: `false`
- Purpose: include `_debugSignals` in internal report from `analyzeUrl()`
- Misconfigured impact: larger payloads and extra internal detail exposure

## Recommended Baselines

### Development (API-only)

```dotenv
NODE_ENV=development
PORT=3001
SERVE_STATIC=0
CORS_ALLOW_ORIGIN=*
AUTH_ENABLED=0
```

### Integrated production

```dotenv
NODE_ENV=production
PORT=3001
SERVE_STATIC=1
STATIC_DIST_DIR=/app/frontend/dist
CORS_ALLOW_ORIGIN=off
AUTH_ENABLED=1
AUTH_ALLOW_HEALTH=1
REQUEST_LOG=1
```

Use HTTPS when auth is enabled.

## Validation

Run config validation:

```bash
cd backend
npm run validate-config
```

Also see:

- `API.md`
- `SECURITY.md`
- `OPERATIONS_GUIDE.md`
