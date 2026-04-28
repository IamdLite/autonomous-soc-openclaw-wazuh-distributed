# =============================================================================
# Autopilot Runtime — Distributed Edition
# Multi-stage build: deps → prune → final (non-root, minimal image)
# =============================================================================

# ── Stage 1: install deps ──────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: final image ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user for security
RUN addgroup -S soc && adduser -S soc -G soc

# Copy deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

# Scripts must be executable
RUN chmod +x src/scripts/*.js

# Switch to non-root
USER soc

# Ports: 8080=health, 9090=metrics
EXPOSE 8080 9090

# Graceful shutdown support
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["node", "src/runtime/index.js"]
