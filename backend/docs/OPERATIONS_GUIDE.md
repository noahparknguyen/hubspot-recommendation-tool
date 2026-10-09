# Operations Guide

This guide is for operating the deployed service: start/stop/restart, health checks, auth operations, smoke checks, and troubleshooting.

## Start, Stop, Restart

### Docker integrated deployment (recommended)

From repo root:

```bash
docker compose up -d --build
```

Stop:

```bash
docker compose down
```

Restart:

```bash
docker compose restart app
```

### Backend process (non-Docker)

From `backend/`:

```bash
npm start
```

Stop with `Ctrl+C` (SIGINT). Server performs graceful shutdown and starts returning `503` for new work while closing.

## Health Verification

Basic checks:

```bash
curl -i "http://localhost:3001/health"
curl -i "http://localhost:3001/api/health"
```

Expected healthy JSON:

```json
{
  "ok": true,
  "service": "HubSpot Recommendation Tool API",
  "shuttingDown": false
}
```

## Post-Deploy Smoke Checks

### API checks

```bash
curl -i "https://your-service.example/health"
curl -i "https://your-service.example/api/health"
curl -i "https://your-service.example/api/analyze?url=https://react.dev"
```

### Auth checks (when `AUTH_ENABLED=1`)

Unauthorized:

```bash
curl -i "https://your-service.example/api/analyze?url=https://react.dev"
```

Authorized:

```bash
curl -i -u "$AUTH_USERNAME:$AUTH_PASSWORD" \
  "https://your-service.example/api/analyze?url=https://react.dev&pretty=1"
```

### Static frontend checks (integrated mode)

```bash
curl -i "https://your-service.example/"
curl -i "https://your-service.example/assets/"
```

Manual check: refresh a non-root SPA route in browser and confirm it loads (SPA fallback).

## Auth Operations

### Enable auth

Set env vars:

```dotenv
AUTH_ENABLED=1
AUTH_USERNAME=...
AUTH_PASSWORD=...
AUTH_REALM=Internal Tool
AUTH_ALLOW_HEALTH=1
```

Restart service.

### Rotate credentials

1. Update `AUTH_USERNAME` and/or `AUTH_PASSWORD`
2. Restart service
3. Re-test with authenticated curl request

## Troubleshooting Matrix

| Problem                         | Likely causes                                                                   | Fix steps                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Server exits on start           | Invalid config, missing auth creds when auth enabled                            | Run `npm run validate-config`; set required env vars; retry start                     |
| `/health` is `401`              | Auth enabled and health not exempt                                              | Set `AUTH_ALLOW_HEALTH=1` or configure probe credentials                              |
| `/analyze` returns `400`        | Invalid URL, unsupported protocol, SSRF blocked host/IP                         | Verify `url` query; test public target URL                                            |
| `/analyze` returns `503`        | Queue full or waited past `ANALYSIS_QUEUE_TIMEOUT_MS`, or shutting down         | Reduce request burst; increase `MAX_CONCURRENT_ANALYSES`/`MAX_QUEUED_ANALYSES`; retry |
| `/analyze` returns `413`        | Response body exceeded max bytes                                                | Increase `MAX_FETCH_BYTES` cautiously                                                 |
| `/analyze` returns `504`        | Fetch timeout, or analysis timeout (error `Analysis timed out`)                 | Increase `FETCH_TIMEOUT_MS` or `ANALYSIS_TIMEOUT_MS`; test target availability        |
| Repeated `401` then `429`       | Bad credentials triggering auth-failure limiter                                 | Correct credentials; wait `Retry-After`; consider adjusting auth rate-limit env vars  |
| Frontend 404 in integrated mode | `SERVE_STATIC=0` or wrong `STATIC_DIST_DIR`                                     | Set static vars, confirm build path, restart                                          |
| SPA route refresh returns 404   | Fallback not reached (accept/proxy/path issue)                                  | Verify request is non-API and accepts HTML; check proxy rules                         |
| Recommendations always empty    | Mapping file missing/invalid (`backend/data/alternatives/hubspot-mapping.json`) | Provide valid mapping file or accept detection-only output                            |

## Operational Notes

- Validate config before deploy:

```bash
cd backend
npm run validate-config
```

- Run smoke test before/after deploy:

```bash
cd backend
npm run smoke
```

- Keep auth behind HTTPS.

## Related Docs

- `RUNBOOK.md`
- `API.md`
- `ENVIRONMENT.md`
- `SECURITY.md`
