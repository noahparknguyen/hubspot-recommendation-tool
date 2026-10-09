# Handoff Checklist – HubSpot Recommendation Tool

Use this checklist during handoff to ensure the client has everything needed to operate the tool.

## Access & Ownership

- [ ] Confirm the hosting URL is correct and accessible
- [ ] Identify and document the internal technical owner (name/team/queue)
- [ ] Identify escalation path for outages or security concerns

## Deployment

- [ ] Confirm deployment mechanism (Docker Compose / host service / platform)
- [ ] Confirm service starts cleanly after reboot
- [ ] Confirm TLS/HTTPS is enabled at the proxy/host layer

## Authentication & Security

- [ ] Decide whether to enable auth (`AUTH_ENABLED=0` is the default — off)
- [ ] If enabling auth: provide shared username/password via a secure channel
- [ ] If enabling auth: confirm health endpoints behave as expected (`AUTH_ALLOW_HEALTH=1`)
- [ ] If enabling auth: confirm auth rate limiting is enabled and configured
- [ ] If the tool is public-facing (no auth): confirm analysis concurrency limits are set appropriately (`MAX_CONCURRENT_ANALYSES`, `MAX_QUEUED_ANALYSES`)

## Verification

- [ ] Health check passes: `GET /health`
- [ ] Smoke test passes: `SMOKE_BASE_URL=https://your-deployed-host npm run smoke`
- [ ] UI loads and core analysis is usable end-to-end

## Documentation

- [ ] Client guide provided: `CLIENT_GUIDE.md`
- [ ] Ops guide provided: `backend/docs/OPERATIONS_GUIDE.md`
- [ ] Dev guide provided: `backend/docs/DEVELOPER_GUIDE.md`
- [ ] Security model provided: `backend/docs/SECURITY.md`
- [ ] Runbook provided: `backend/docs/RUNBOOK.md`

## Password Rotation Drill (Recommended)

- [ ] Rotate password once in staging/test to confirm the procedure
- [ ] Confirm users can log in with new credentials after restart

---

## Render deployment checklist (if using Render)

- [ ] Service created as a **Web Service** (Docker)
- [ ] Health check path set to `/health`
- [ ] `TRUST_PROXY_HOPS=3` set (from `render.yaml`, or in the dashboard), so per-client limits see each client's own address
- [ ] If enabling auth: set `AUTH_ENABLED=1`, `AUTH_USERNAME`, and `AUTH_PASSWORD` as **Secrets** in Render dashboard
- [ ] If auth enabled: confirm login prompt appears on the main URL
- [ ] Confirm `/health` returns 200 without auth
- [ ] Confirm an analysis succeeds from the UI
- [ ] Confirm the client receives:
  - the URL
  - credentials (if auth enabled) delivered out of band
  - the Client Guide (non-technical)
