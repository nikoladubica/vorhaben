#!/bin/sh
# Container entrypoint: bring the schema up to date, then start the server.
# MariaDB readiness is guaranteed by the compose healthcheck (app depends_on it),
# so migrations can run immediately on boot.
set -e

echo "→ Running database migrations..."
npm run migrate:prod --workspace server

echo "→ Starting vorhaben..."
exec node server/dist/index.js
