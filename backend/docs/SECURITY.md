# Security Guide

This document describes implemented backend security controls, their limits, and pre-deployment checks. It covers only controls verified in source.

## Implemented Controls

### SSRF protection

Files: `src/core/fetch/ssrf.js`, `src/core/fetch/fetchPage.js`

- Blocks localhost and common internal hostnames (`.local`, `.internal`, `.lan`)
- Resolves hostnames and blocks if any resolved IP is private/loopback/link-local/reserved
- Blocks private IPv4 ranges (`10/8`, `172.16/12`, `192.168/16`, etc.)
- Blocks private/loopback IPv6 ranges (`::1`, `fc00::/7`, `fe80::/10`, mapped loopback)
- Blocks reserved ranges that are never public web servers: documentation, benchmarking, multicast, and the NAT64 and 6to4 prefixes that embed an IPv4 address
- Re-checks host policy on every redirect hop
- Checks the address each connection actually uses: the connection's own DNS lookup (`safeLookup`) refuses blocked addresses, so a hostile DNS server can't pass the check with a public address and then send the connection to a private one (DNS rebinding)

Limitations:

- Application-level SSRF checks are not a replacement for network egress controls

### Fetch limits

Files: `src/core/fetch/fetchPage.js`, `src/core/config.js`

- Timeout deadline (`FETCH_TIMEOUT_MS`)
- Max primary response bytes (`MAX_FETCH_BYTES`)
- Redirect limit
- External JS/CSS fetches are bounded by:
  - count limits
  - per-resource byte cap
  - total external byte budget
  - concurrency limit

Limitations:

- Aggressive target-side anti-bot/firewall controls can still cause fetch failure or incomplete signals

### Analysis time limit

Files: `src/core/worker/runAnalysis.js`, `src/core/worker/analysisThread.js`

- Detection runs on a worker thread, so a page crafted to make the dataset's patterns backtrack can't stall the server's main thread
- Past `ANALYSIS_TIMEOUT_MS`, the thread is stopped mid-analysis and the request gets a `504`; the next analysis starts a fresh thread

Limitations:

- One thread runs one analysis at a time, so a slow page delays the analyses queued behind it, by up to `ANALYSIS_TIMEOUT_MS` each

### HTTP Basic Auth

Files: `src/api/server.js`, `src/api/auth.js`

- Optional global gate (`AUTH_ENABLED`)
- Covers API + static routes
- Optional health exemption (`AUTH_ALLOW_HEALTH`)
- Uses constant-time compare (`timingSafeEqual`) for same-length values
- Returns standards-based challenge (`WWW-Authenticate`)
- Startup fails if auth enabled without username/password

Limitations:

- Basic Auth is lightweight, not full IAM
- Must run behind HTTPS

### Failed-auth rate limiting

Files: `src/api/rateLimit.js`, `src/api/clientIp.js`, `src/api/server.js`

- In-memory per-IP failure tracking
- The client's address comes from `X-Forwarded-For` only as far as `TRUST_PROXY_HOPS` proxies vouch for it, so a client can't dodge the limit by forging that header
- Sliding window + temporary block
- Sends `429` with `Retry-After`
- Success clears IP state

Limitations:

- Per-process only
- Resets on restart
- Not distributed across replicas

### Per-client analysis limit (optional)

Files: `src/api/routes/analyze.js`, `src/api/rateLimit.js`, `src/api/clientIp.js`

- Off unless `ANALYZE_RATE_LIMIT_PER_HOUR` is set; meant for a public demo
- Past the limit, the client gets `429` with `Retry-After` and is blocked for an hour
- Keyed by the same client address as the failed-auth limiter, so forging `X-Forwarded-For` doesn't reset it

Limitations:

- Same as failed-auth rate limiting: per-process, and reset on restart

### Analysis back-pressure controls

File: `src/api/analysisLimiter.js`

- In-memory max concurrent analysis slots
- Bounded queue
- Returns `503` overload error when queue full
- A queued request waits at most `ANALYSIS_QUEUE_TIMEOUT_MS`, then gets a `503`
- A queued request whose visitor disconnects leaves the queue, so it never costs an analysis

### Static file path traversal protection

File: `src/api/static.js`

- Decodes path safely
- Removes NUL bytes
- Resolves path and verifies it stays within configured static root
- Supports only `GET` and `HEAD` for static serving

### Security headers

File: `src/api/server.js`

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY`

Limitations:

- CSP is intentionally not set in backend; comment in code recommends setting CSP at proxy/frontend policy layer

### CORS control

File: `src/api/server.js`

- Controlled by `CORS_ALLOW_ORIGIN`
- Can be disabled with `off`
- In production integrated mode with wildcard origin, CORS headers are skipped

## Intentionally Not Implemented

Verified absent in backend code:

- Session management
- User accounts/roles
- OAuth/OIDC
- CSRF token framework
- Persistent/distributed abuse tracking
- Built-in WAF behavior

## Pre-Deployment Security Checklist

- Use HTTPS termination at hosting/proxy layer
- If private/internal deployment, set:
  - `AUTH_ENABLED=1`
  - `AUTH_USERNAME` and `AUTH_PASSWORD` from secret store
- Decide health auth posture (`AUTH_ALLOW_HEALTH`)
- Set conservative CORS:
  - same-origin integrated mode: `CORS_ALLOW_ORIGIN=off` recommended
- Validate config:

```bash
cd backend
npm run validate-config
```

- Run smoke test:

```bash
cd backend
npm run smoke
```

- Verify auth and rate limiting behavior:

```bash
curl -i "http://localhost:3001/api/analyze?url=https://react.dev"
```

## Honest Limitations

- Some sites block automation; this can reduce signal quality
- App-level SSRF defenses should be backed by infrastructure egress policy
- In-memory rate limiting and analysis limiting do not coordinate across multiple instances

## Related Docs

- `API.md`
- `ENVIRONMENT.md`
- `OPERATIONS_GUIDE.md`
- `RUNBOOK.md`
