# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you discover a security issue in this project, report it privately: open this repository's **Security** tab and choose **Report a vulnerability**.

Include a description of the vulnerability, steps to reproduce it, and the potential impact. We will respond as quickly as possible and work with you to address the issue before any public disclosure.

## Security Model

This project includes several built-in security controls:

- **SSRF protection:** outbound fetches are validated against a blocklist of private, loopback, and reserved IP ranges before every request and redirect hop, and again as each connection is made, so DNS rebinding can't get around the check
- **Analysis time limit:** detection runs on a worker thread and is stopped if it runs too long, so a page crafted to be slow can't stall the server
- **HTTP Basic Auth:** optional authentication gate covering all API and static routes
- **Failed-auth rate limiting:** in-memory per-IP limiting with configurable thresholds
- **Per-visitor analysis limit:** an optional hourly cap on each visitor's analyses, for a public demo
- **Request size and timeout limits:** bounded response bodies and connection timeouts to prevent resource exhaustion

For full technical details, see [`backend/docs/SECURITY.md`](../backend/docs/SECURITY.md).

## Supported Versions

This is a capstone project maintained on a best-effort basis. Security fixes will be applied to the latest version on `main`.
