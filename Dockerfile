# syntax=docker/dockerfile:1

# --- Build stage: install everything and compile client + server ----------------
FROM node:20-alpine AS build
WORKDIR /app

# Install deps first for better layer caching. Copy every workspace manifest so
# `npm ci` can resolve the workspace graph.
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci

# Copy the source and build both workspaces (server: tsc -> dist, client: vite build).
COPY . .
RUN npm run build

# --- Runtime stage: production deps + built artifacts only ----------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only (drops tsx, typescript, vite, etc). knex + mysql2
# are runtime deps, so the migration CLI is still available.
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev

# Compiled server (includes dist/db/migrations) and the static client bundle.
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

EXPOSE 4001
ENTRYPOINT ["./docker-entrypoint.sh"]
