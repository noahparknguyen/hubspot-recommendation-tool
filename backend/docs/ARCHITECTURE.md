# Backend Architecture

This document explains the backend architecture for developers joining the project. It covers runtime components, the five-phase analysis pipeline, request flow, and deployment topology.

## System Components

```text
User Browser (React SPA)
    -> Backend HTTP Server (Node.js, no framework)
        -> Analysis Pipeline
            -> Local Wappalyzer-style dataset (JSON files on disk, loaded in memory)
        -> Optional static file server (frontend build output)
    -> Target public websites (outbound fetch)
```

Main directories:

- `frontend/`: React + Vite UI
- `backend/src/api/`: HTTP server/auth/routing/static serving
- `backend/src/core/`: analysis engine
- `backend/data/vendor/webappanalyzer/src/`: technology dataset (WebAppAnalyzer/enthec, GPL-3.0 — see root `NOTICE`)

## Backend Layering

- Transport layer: `src/api/server.js`
- Route adapter: `src/api/routes/analyze.js`
- Core orchestration: `src/core/analyzer.js`
- Specialized core modules:
  - `src/core/fetch/*`
  - `src/core/normalize/*`
  - `src/core/detect/*`
  - `src/core/report/*`
  - `src/core/worker/*`

The route layer stays thin and delegates logic to core modules.

## Five-Phase Analysis Pipeline

Pipeline entry point: `analyzeUrl()` in `src/core/analyzer.js`.

Phases 3 to 5 are CPU-bound, so they run on a worker thread (`src/core/worker/`) under a time limit, `ANALYSIS_TIMEOUT_MS`. Some dataset patterns backtrack badly on crafted pages, and a regex can't be interrupted once it starts. On the server's main thread, one such page would stall every request, health checks included. The worker thread can be stopped mid-regex: the request gets a `504`, and the next analysis starts a fresh thread. The thread runs one analysis at a time, and each one's time limit starts when the thread takes it.

### Phase 1 - Database Loading (`loadTechDb`)

File: `src/core/techdb/loadTechDb.js`

Dataset source: [WebAppAnalyzer](https://github.com/enthec/webappanalyzer) by enthec (GPL-3.0). Vendored at `backend/data/vendor/webappanalyzer/src/`. See root `NOTICE` for full attribution.

- Loads:
  - `categories.json`
  - `groups.json`
  - `technologies/_.json`
  - `technologies/a.json` through `technologies/z.json`
- Verifies required files exist before loading
- Parses JSON and merges technologies into one map by technology name
- Builds a lightweight matcher index (`headers`, `scriptSrc`, `meta`, `url`, `cookies`, `scripts`, `dom`, `text`, `html`, `css`, plus relation keys)
- Loaded once by the analysis thread and cached there (`initTechDb()` in `analyzeFetched.js`)

### Phase 2 - Page Fetching (`fetchPage`)

Files: `src/core/fetch/fetchPage.js`, `src/core/fetch/ssrf.js`

- Accepts only `http` and `https` URLs
- Applies SSRF host/IP checks (`assertPublicHost`) on each fetch and every redirect hop
- Blocks private/loopback/link-local/local-reserved destinations
- Uses manual redirect handling with max redirects
- Enforces timeout deadline and max bytes for response bodies
- Fetches primary HTML
- Best-effort fetches bounded external scripts/styles for better detection coverage
- Returns:
  - `requestedUrl`, `finalUrl`
  - `status`, `statusText`
  - `headers`, `contentType`, `bytes`, `timingMs`
  - `html`
  - `external` (`scripts`, `stylesheets`, `skipped`)

### Phase 3 - Signal Normalization (`buildSignals`)

File: `src/core/normalize/signals.js`

- Converts fetch output into stable signals:
  - `url`
  - `urlParams`
  - `headers`
  - `cookies` (names only)
  - `meta`
  - `scriptSrc`
  - `scripts` (inline + fetched scripts text)
  - `css` (`hrefs` + inline/fetched stylesheet text)
  - `text`
  - `html`
  - `dom` (Cheerio root function)
- Applies caps to large text fields to bound CPU/memory use
- Normalizes URLs and deduplicates resolved resource URLs

### Phase 4 - Technology Detection (`detectTechnologies`)

File: `src/core/detect/detectTechnologies.js`

Runs ten matchers in a stable order:

- `url`
- `headers`
- `cookies`
- `meta`
- `html`
- `text`
- `scriptSrc`
- `scripts`
- `css`
- `dom`

Behavior:

- Matchers return candidate matches with confidence and optional version/evidence
- Confidence is aggregated using probabilistic OR and clamped to `0..100`
- Relationship resolution runs after matcher pass:
  - `requires`
  - `implies`
  - `excludes`
- Final detection threshold is applied after relationship resolution (`minConfidence`, default `50`)

### Phase 5 - Report Generation

Files:

- `src/core/report/enrichDetections.js`
- `src/core/report/recommendations.js`
- `src/core/report/summarize.js`
- `src/core/report/groupDetections.js`
- `src/core/report/cleanReport.js`

Flow inside `analyzeFetched.js`:

1. `enrichDetections`: add description, website, icon, category/group taxonomy
2. `buildSummary`: compute totals and counts by group/category
3. `groupDetections`: bucket detections by group name
4. `buildRecommendations`: map detections/categories/groups to HubSpot recommendations

Important implementation detail:

- Mapping file path defaults to `backend/data/alternatives/hubspot-mapping.json`
- If mapping file is missing or invalid, recommendations fall back to empty instead of failing the request

API response shaping then happens in `buildFrontendReport()` in `cleanReport.js`.

## Frontend-Backend Integration

### Development mode

- Frontend Vite server runs separately
- Frontend hook calls `${VITE_API_URL || "/api"}/analyze`
- Backend usually runs with `SERVE_STATIC=0`
- CORS can be enabled with `CORS_ALLOW_ORIGIN`

### Production/integrated mode

- Root Docker build compiles frontend to `frontend/dist`
- Backend runs with `SERVE_STATIC=1` and serves built assets
- API and UI share origin
- CORS commonly set to `off` in integrated mode

## Request Flow Diagrams

### Health Request

```text
GET /health or /api/health
  -> server.js
  -> optional auth gate (can be bypassed when AUTH_ALLOW_HEALTH=1)
  -> JSON { ok: true, service, shuttingDown: false }
```

### Analyze Request

```text
GET /analyze?url=... or /api/analyze?url=...
  -> server.js route match
  -> optional auth gate + optional auth-failure rate limiter
  -> analyze route input validation
  -> optional per-client limit (ANALYZE_RATE_LIMIT_PER_HOUR; 429 past it)
  -> analysisLimiter.acquire() (concurrency/queue guardrail)
  -> analyzeUrl() five-phase pipeline
     (phases 3-5 on the analysis thread; 504 past ANALYSIS_TIMEOUT_MS)
  -> buildFrontendReport()
  -> JSON response
```

### Static Frontend Request (Integrated Mode)

```text
GET / or /assets/... or SPA route
  -> server.js
  -> optional auth gate
  -> tryServeStatic() for file hit
  -> if no file and request accepts HTML and non-/api path:
       tryServeSpaFallback() -> index.html
  -> else 404 JSON
```

## Deployment Model

### Local development

- Run backend from `backend/`
- Optionally run frontend separately from `frontend/`
- Fast iteration, separate processes

### Docker/integrated production

- Root `Dockerfile` builds frontend and backend runtime image
- Backend process serves both API and static frontend
- Health endpoint available at `/health`

See:

- `../README.md`
- `API.md`
- `ENVIRONMENT.md`
- `OPERATIONS_GUIDE.md`
