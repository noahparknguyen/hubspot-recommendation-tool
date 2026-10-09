# Developer Guide

This guide is for developers who need to run, debug, and extend the HubSpot Recommendation Tool. It focuses on practical setup and safe extension points in the current codebase.

## Prerequisites

- Node.js `>=24`, the version the Docker image and CI run
- npm
- Docker (for integrated local/prod-parity runs)

## Local Setup

### Backend setup

```bash
cd backend
cp .env.example .env   # creates local env config — loaded automatically by npm scripts via --env-file-if-exists
npm install
npm run dev
```

### Frontend setup

```bash
cd frontend
npm install
npm run dev
```

### Frontend -> backend API in dev

By default frontend uses `/api`. For separate backend host:

```bash
cd frontend
VITE_API_URL=http://localhost:3001/api npm run dev
```

## Docker Setup (Integrated)

From repo root:

```bash
cp .env.example .env
docker compose up --build
```

Integrated mode serves UI and API from backend process on `:3001`.

## Run Tests And Tools

### Backend tests

```bash
cd backend
npm test
npm run test:coverage
```

### Smoke test

Direct mode (no running server required):

```bash
cd backend
npm run smoke
```

API mode (against running server):

```bash
cd backend
SMOKE_BASE_URL=http://localhost:3001 npm run smoke
```

### Config validation

```bash
cd backend
npm run validate-config
```

If `npm start` fails, it is usually because `prestart` runs `validate-config` and found a configuration error.

Use this sequence:

1. Run validation directly to see exact errors:

```bash
cd backend
npm run validate-config
```

2. Fix the reported `.env` values or missing files:
   - invalid numeric env values
   - missing required auth values when `AUTH_ENABLED=1`
   - missing dataset files under `DATA_ROOT`
   - invalid timeout relationships (for example, `HTTP_HEADERS_TIMEOUT_MS` lower than `HTTP_REQUEST_TIMEOUT_MS`)

3. Re-run validation, then start again:

```bash
npm start
```

### CLI

```bash
cd backend
npm run cli -- https://react.dev
npm run cli -- https://react.dev --format human --wide
npm run cli:tax -- --pretty
```

## Codebase Navigation

Backend HTTP layer:

- `src/api/server.js`: request handling, auth gate, CORS/security headers, route dispatch, static serving
- `src/api/routes/analyze.js`: query validation and response shaping
- `src/api/auth.js`: Basic Auth parsing/comparison/challenge
- `src/api/rateLimit.js`: in-memory auth failure limiter
- `src/api/analysisLimiter.js`: in-memory analysis concurrency/queue guardrail

Backend analysis pipeline:

- `src/core/analyzer.js`: pipeline orchestration and cached DB init
- `src/core/techdb/loadTechDb.js`: dataset loading/indexing
- `src/core/fetch/*`: fetch + SSRF controls
- `src/core/normalize/signals.js`: signal normalization
- `src/core/detect/*`: matcher engine + relationship resolution
- `src/core/report/*`: enrichment, grouping, summary, recommendations, clean output

Frontend:

- `frontend/src/App.jsx`: top-level page and result state
- `frontend/src/hooks/useWebsiteAnalysis.js`: API lifecycle hook
- `frontend/src/components/UrlInput.jsx`: input, validation, submit
- `frontend/src/components/UrlReport.jsx`: result rendering

## Safe Extension Guidelines

- Keep new route handlers thin; place core behavior under `src/core/`
- Preserve `AppError` usage for operational failures and clear status mapping
- Preserve fetch safety boundaries:
  - protocol checks
  - SSRF checks per redirect hop
  - timeout and byte limits
- Keep analyzer output shape stable for frontend:
  - `ok`
  - `apiVersion`
  - `technologies`
  - `byGroup`
  - `recommendations`
  - `summary`
- If adding environment variables:
  - update `src/core/config.js`
  - update `src/scripts/validateConfig.js`
  - update `docs/ENVIRONMENT.md`

## Known Source-Backed Caveat

- Recommendation mapping loads from `backend/data/alternatives/hubspot-mapping.json`.
- If this file is missing or invalid, recommendation output is intentionally empty and detection still succeeds.

## Related Docs

- `ARCHITECTURE.md`
- `API.md`
- `ENVIRONMENT.md`
- `SECURITY.md`
- `OPERATIONS_GUIDE.md`
- `CLI.md`
