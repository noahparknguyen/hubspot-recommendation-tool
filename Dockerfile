# ---------- Stage 1: build frontend ----------
# Node 24 matches backend engines (>=24), backend/.nvmrc, and CI. Keep all four in sync.
FROM node:24-alpine AS frontend-build
WORKDIR /frontend

COPY frontend/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ ./
RUN npm run build


# ---------- Stage 2: install backend deps ----------
FROM node:24-alpine AS backend-deps
WORKDIR /backend

COPY backend/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi


# ---------- Stage 3: runtime image ----------
FROM node:24-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache dumb-init

# Backend deps + source + data
COPY --from=backend-deps --chown=node:node /backend/node_modules ./backend/node_modules
COPY --chown=node:node backend/src ./backend/src
COPY --chown=node:node backend/data ./backend/data

# Frontend build output
COPY --from=frontend-build --chown=node:node /frontend/dist ./frontend/dist

# AUTH_ENABLED defaults to 0 so the image works out-of-the-box in development.
# Override to 1 (with AUTH_USERNAME + AUTH_PASSWORD) for any networked deployment.
ENV NODE_ENV=production \
    PORT=3001 \
    REQUEST_LOG=1 \
    SERVE_STATIC=1 \
    STATIC_DIST_DIR=/app/frontend/dist \
    STATIC_ASSET_CACHE_SECONDS=2592000 \
    CORS_ALLOW_ORIGIN=off \
    DATA_ROOT=/app/backend/data/vendor/webappanalyzer/src \
    FETCH_TIMEOUT_MS=12000 \
    MAX_FETCH_BYTES=2000000 \
    MAX_CONCURRENT_ANALYSES=8 \
    MAX_QUEUED_ANALYSES=32 \
    HTTP_REQUEST_TIMEOUT_MS=30000 \
    HTTP_HEADERS_TIMEOUT_MS=35000 \
    HTTP_KEEP_ALIVE_TIMEOUT_MS=5000 \
    HTTP_MAX_REQUESTS_PER_SOCKET=100 \
    AUTH_ENABLED=0 \
    AUTH_REALM="Internal Tool" \
    AUTH_ALLOW_HEALTH=1

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/src/api/server.js"]