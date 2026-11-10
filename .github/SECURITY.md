# Security Policy

## Status

This project is finished and archived. It gets no further updates or security fixes, and vulnerability reports aren't monitored. If you run your own copy, keeping it up to date is up to you.

## Security Model

This project includes several built-in security controls:

- **SSRF protection:** outbound fetches are validated against a blocklist of private, loopback, and reserved IP ranges before every request and redirect hop, and again as each connection is made, so DNS rebinding can't get around the check
- **Analysis time limit:** detection runs on a worker thread and is stopped if it runs too long, so a page crafted to be slow can't stall the server
- **HTTP Basic Auth:** optional authentication gate covering all API and static routes
- **Failed-auth rate limiting:** in-memory per-IP limiting with configurable thresholds
- **Per-visitor analysis limit:** an optional hourly cap on each visitor's analyses, for a public demo
- **Request size and timeout limits:** bounded response bodies and connection timeouts to prevent resource exhaustion

For full technical details, see [`backend/docs/SECURITY.md`](../backend/docs/SECURITY.md).
