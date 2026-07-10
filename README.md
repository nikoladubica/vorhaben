# vorhaben

Track and manage your business endeavours - an open-source project tracker for people juggling
more than one thing at once.

*Vorhaben* is German for "undertaking" / "venture".

## Stack

- **Client**: React + TypeScript (Vite)
- **Server**: Node.js + TypeScript (Express)
- **Database**: MariaDB (via [Knex](https://knexjs.org/) + `mysql2`)

## Project layout

```
vorhaben/
├── client/   React + TypeScript frontend (Vite)
├── server/   Node.js + TypeScript API (Express, Knex, MariaDB)
└── docker-compose.yml   Local MariaDB for development
```

## Self-hosting (one command)

Run the whole app — server, built client, and database — with Docker. The only
prerequisite is **Docker** (with Compose). No Node install required.

```bash
git clone https://github.com/nikoladubica/vorhaben.git
cd vorhaben
cp .env.example .env

# set a signing secret (required) — any long random string
sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env   # macOS
# Linux: sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env

docker compose up -d
```

That's it. Open **http://localhost:8080** and create your account.

Compose builds the app image, waits for MariaDB to be healthy, runs database
migrations on boot, and serves everything on one port. Your data lives in
`./.docker/mariadb-data`.

| Task | Command |
| --- | --- |
| Start / update | `docker compose up -d --build` |
| Stop | `docker compose down` |
| View logs | `docker compose logs -f app` |
| Change the port | set `APP_PORT` in `.env` (default `8080`) |

**Serving over HTTPS?** Put it behind a reverse proxy (Caddy, nginx, Traefik) and
set `COOKIE_SECURE=true` in `.env` so the login cookie is marked `Secure`. Leave it
`false` for plain-HTTP access, or the browser will drop the session cookie.

> Keep `JWT_SECRET` stable — changing it invalidates everyone's login sessions.

### Voice capture (optional LLM structuring)

Voice capture works with no configuration — transcription runs in the browser and a
built-in rules parser turns the transcript into a checklist, note, reminder, or event.
Setting an Anthropic API key upgrades the parse step to an LLM for cleaner titles, better
item splitting, and resolved dates. It only ever improves the parse; every capture kind is
fully usable without a key, and any LLM error falls back to the rules parser.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | _(unset)_ | Enables LLM structuring. Unset → rules parser only. Never exposed to the client. |
| `VOICE_LLM_MODEL` | `claude-opus-4-8` | Model used for structuring when a key is set. |

The transcript is sent to Anthropic only when a key is configured; audio never leaves the
browser, and `POST /api/voice/parse` never persists anything.

## Development

### Prerequisites

- Node.js >= 20
- Docker (for local MariaDB), or a MariaDB instance you already have running

### Setup

```bash
cp .env.example .env
npm install

# start a local MariaDB
docker compose up -d mariadb

# run migrations
npm run migrate

# start client + server in dev mode
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:4001 (proxied under `/api` from the client dev server)

### Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Run client and server in watch mode |
| `npm run build` | Build client and server for production |
| `npm run lint` | Lint client and server |
| `npm run format` | Format the repo with Prettier |
| `npm run typecheck` | Type-check client and server |
| `npm run migrate` | Run database migrations |
| `npm run migrate:rollback` | Roll back the last migration batch |

## Documentation

Deeper docs live in `.claude/docs/`:

- [`backend/data-model.md`](.claude/docs/backend/data-model.md) — every table, columns, indexes, FKs.
- [`backend/api.md`](.claude/docs/backend/api.md) — the full HTTP API, grouped by resource, with curl examples.
- [`backend/normalization.md`](.claude/docs/backend/normalization.md) — how revenue and hourly-rate figures are computed.

The full product spec lives in [`BUSINESS_LOGIC.md`](./BUSINESS_LOGIC.md).

## Contributing

Issues and pull requests are welcome. This project is early-stage — expect the structure to
evolve.

## License

[MIT](./LICENSE)
