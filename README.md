# HubSpot Recommendation Tool

Paste in a prospect's website URL and instantly see what technologies they use — and which HubSpot products could replace them.

Built as a capstone project by Team Debug (Algonquin College) for Inbox, a HubSpot Platinum Solutions Partner in Ottawa.

[![CI](https://img.shields.io/github/actions/workflow/status/noahparknguyen/hubspot-recommendation-tool/ci.yml?logo=githubactions&logoColor=white&label=CI)](https://github.com/noahparknguyen/hubspot-recommendation-tool/actions/workflows/ci.yml)
[![GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](https://react.dev)
[![Node](https://img.shields.io/badge/Node-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Vite](https://img.shields.io/badge/Vite-7-646cff?logo=vite&logoColor=white)](https://vite.dev)
[![Jest](https://img.shields.io/badge/Jest-29-c21325?logo=jest&logoColor=white)](https://jestjs.io)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)](https://docker.com)

🔗 **Live Demo:** [hubspot-recommendation-tool.onrender.com](https://hubspot-recommendation-tool.onrender.com/) — hosted on a free tier that sleeps when idle, so the first load can take up to a minute.

![The HubSpot Recommendation Tool — paste a website URL and press Analyze](docs/home.png)

## What It Does

A client comes to Inbox with an existing site, and Inbox works out what it's running and what could be consolidated into HubSpot instead. That research was manual. This tool is a shortcut for it: fetch the target site, fingerprint its technology stack using a Wappalyzer-style detection engine, and map each detected tool to the HubSpot product that could replace it — in seconds.

It's meant to speed up discovery, not replace it. The output is a starting point for the conversation, not the conclusion.

![A finished report: each detected technology with its category, description, and the HubSpot product that could replace it](docs/report.png)

Key capabilities:

- Detects hundreds of technologies via a 10-matcher fingerprint pipeline (HTTP headers, script sources, DOM, cookies, meta tags, inline scripts, CSS, and more)
- Maps detections to HubSpot products via a configurable JSON file — no code changes required to add or update recommendations
- Optional HTTP Basic Auth with in-memory failed-auth rate limiting
- CLI tool for running analyses directly from the terminal
- Single-container Docker deployment; live instance hosted on Render
- Frontend theming via CSS custom properties — all colors and typography live in a single `:root` block so the whole app can be rebranded by editing one file; nothing is hardcoded outside that block
- Accessible form: `aria-live` status announcements, `aria-invalid` and `aria-describedby` wired to the input's error state, validation deferred until blur or submit so users aren't interrupted mid-type

## Deploying Your Own Instance

Fork this repo, clone it, and follow the Docker setup below. All configuration is handled through environment variables — no code changes needed to stand up your own deployment.

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/noahparknguyen/hubspot-recommendation-tool.git
cd hubspot-recommendation-tool
cp .env.example .env
docker compose up --build
```

Open http://localhost:3001 or verify the API:

```bash
curl http://localhost:3001/health
```

Optional: enable auth in `.env` before starting:

```dotenv
AUTH_ENABLED=1
AUTH_USERNAME=your-user
AUTH_PASSWORD=your-pass
```

### Local development

```bash
# Backend (terminal 1)
cd backend && npm install && npm run dev

# Frontend (terminal 2)
cd frontend && npm install && npm run dev
```

Frontend runs at http://localhost:5173 and proxies `/api` to the backend at http://localhost:3001.

### Quick API call

```bash
curl "http://localhost:3001/api/analyze?url=https://react.dev"
```

## Tech Stack

| Layer          | Technology                                                                               |
| -------------- | ---------------------------------------------------------------------------------------- |
| Frontend       | React 18, Vite 7                                                                         |
| Backend        | Node.js 20 (vanilla `http` — no framework)                                               |
| Detection data | [WebAppAnalyzer](https://github.com/enthec/webappanalyzer) fingerprint dataset (GPL-3.0) |
| HTML parsing   | Cheerio                                                                                  |
| Testing        | Jest (backend), Vitest (frontend)                                                        |
| Deployment     | Docker, Render                                                                           |

## Documentation

Full technical docs live in [`backend/docs/`](backend/docs/) — covering the API, architecture, environment variables, security model, and deployment guide.

Client-facing guides: [`CLIENT_GUIDE.md`](CLIENT_GUIDE.md) · [`TEAM_GUIDE.md`](TEAM_GUIDE.md)

## Third-Party Licenses

The technology fingerprint dataset in `backend/data/vendor/webappanalyzer/` is sourced from [WebAppAnalyzer](https://github.com/enthec/webappanalyzer) (enthec) and licensed under [GPL-3.0](https://github.com/enthec/webappanalyzer/blob/main/LICENSE). See [`NOTICE`](NOTICE) for full details.

---

[GPL-3.0](LICENSE) · Capstone project · Team Debug · Algonquin College Computer Engineering Technology · Built for Inbox
