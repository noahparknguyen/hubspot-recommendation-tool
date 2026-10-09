# Runbook

This is the quick-reference incident and deployment runbook for the backend service.

## Pre-Deploy Checklist

- `.env` / platform env vars set correctly
- `AUTH_USERNAME` and `AUTH_PASSWORD` present if `AUTH_ENABLED=1`
- Static mode settings correct if integrated deployment:
  - `SERVE_STATIC=1`
  - `STATIC_DIST_DIR` points to built frontend
- Config validation passes:

```bash
cd backend
npm run validate-config
```

- Smoke test passes:

```bash
cd backend
npm run smoke
```

## Start Commands

Docker integrated:

```bash
docker compose up -d --build
```

Backend only:

```bash
cd backend
npm start
```

## Verification Commands

Health:

```bash
curl -i "http://localhost:3001/health"
curl -i "http://localhost:3001/api/health"
```

Analyze:

```bash
curl -i "http://localhost:3001/api/analyze?url=https://react.dev"
```

Analyze with auth:

```bash
curl -i -u "$AUTH_USERNAME:$AUTH_PASSWORD" \
  "http://localhost:3001/api/analyze?url=https://react.dev&pretty=1"
```

Static root check (integrated mode):

```bash
curl -i "http://localhost:3001/"
```

Invalid API route check:

```bash
curl -i "http://localhost:3001/api/not-found"
```

## Troubleshooting Matrix

| Symptom                       | Likely cause                                        | Action                                                                            |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Process exits immediately     | Invalid env or missing auth creds with auth enabled | Run `npm run validate-config`, fix env, restart                                   |
| Health endpoint returns `401` | Auth enabled and health not exempt                  | Set `AUTH_ALLOW_HEALTH=1` or authenticate probe                                   |
| Analyze returns `400`         | Bad URL input or SSRF block                         | Validate `url`, use public `http/https` target                                    |
| Analyze returns `503`         | Queue full or waited too long, or shutdown mode     | Retry; tune `MAX_CONCURRENT_ANALYSES`/`MAX_QUEUED_ANALYSES`; check shutdown state |
| Analyze returns `413`/`504`   | Response too large, or fetch or analysis timeout    | Tune `MAX_FETCH_BYTES`/`FETCH_TIMEOUT_MS`/`ANALYSIS_TIMEOUT_MS`                   |
| Repeated `401` and then `429` | Invalid credentials triggering limiter              | Correct creds; wait `Retry-After`; adjust auth rate-limit vars if needed          |
| Frontend 404/blank            | Static mode off or wrong dist path                  | Enable `SERVE_STATIC`; set correct `STATIC_DIST_DIR`; redeploy                    |
| SPA route refresh 404         | Fallback not reached due proxy or request shape     | Verify non-API HTML navigation and proxy pass-through                             |
| Recommendations empty         | Missing/invalid mapping file                        | Add valid `backend/data/alternatives/hubspot-mapping.json`                        |

## Recovery Sequence

1. Confirm process up and health endpoint status.
2. Confirm auth behavior (`401` unauth, success with valid auth).
3. Confirm analyze on known URL (`https://react.dev`).
4. If integrated, confirm `/` and SPA refresh behavior.
5. Check logs for `500`, `502`, `503`, `504`, or repeated `429`.
6. Validate env/config and static path.
7. Restart service and re-run verification.

## Related Docs

- `OPERATIONS_GUIDE.md`
- `API.md`
- `ENVIRONMENT.md`
- `SECURITY.md`
