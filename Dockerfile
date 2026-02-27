# ── Stage 1: Build frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app/web/frontend
COPY web/frontend/package.json web/frontend/package-lock.json* ./
RUN npm ci --ignore-scripts
COPY web/frontend/ ./
RUN npm run build

# ── Stage 2: Production image ───────────────────────────────────────────────
FROM node:20-alpine

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install backend dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Copy backend source
COPY backend/ ./backend/

# Copy built frontend from stage 1
COPY --from=frontend-build /app/web/frontend/dist ./web/frontend/dist

# Create data directories (uploads + fallback JSON store)
RUN mkdir -p /data/uploads /app/backend/data && chown -R appuser:appgroup /data /app

USER appuser

# Default env vars (overridden via Railway dashboard)
ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOADS_DIR=/data/uploads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "backend/index.js"]
