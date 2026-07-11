# vorhaben

Track and manage your business endeavours - an open-source project tracker for people juggling
more than one thing at once.

_Vorhaben_ is German for "undertaking" / "venture".

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

| Task            | Command                                   |
| --------------- | ----------------------------------------- |
| Start / update  | `docker compose up -d --build`            |
| Stop            | `docker compose down`                     |
| View logs       | `docker compose logs -f app`              |
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

| Variable            | Default            | Purpose                                                                          |
| ------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | _(unset)_          | Enables LLM structuring. Unset → rules parser only. Never exposed to the client. |
| `VOICE_LLM_MODEL`   | `claude-haiku-4-5` | Model used for voice-capture structuring when a key is set.                      |

The transcript is sent to Anthropic only when a key is configured; audio never leaves the
browser, and `POST /api/voice/parse` never persists anything.

### Hosted-assistant metering (optional)

On the hosted plan, every server-side LLM call made with the platform `ANTHROPIC_API_KEY`
routes through one gateway that meters tokens per user and enforces a monthly fair-use cap.
Usage is surfaced to users only as a percentage (Settings → Assistant); raw token counts are
internal and never reach the client. Self-host instances with no key see no meter. A user's own
key (BYOK, future) bypasses metering and the cap entirely. These caps and per-feature models are
env-overridable so nothing is hardcoded at the call sites:

| Variable                   | Default            | Purpose                                                                                                       |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `LLM_MONTHLY_TOKEN_CAP`    | `5000000`          | General assistant budget per user per calendar month. Chat pauses when it is reached.                         |
| `LLM_RESERVE_TOKENS`       | `300000`           | Extra pipeline-only reserve above the cap — voice capture and digests keep running from it after chat pauses. |
| `CHAT_LLM_MODEL`           | `claude-haiku-4-5` | Model for the (future) chat feature.                                                                          |
| `DIGEST_LLM_MODEL`         | `claude-haiku-4-5` | Model for the (future) email digest feature.                                                                  |
| `INVOICE_SCAN_MODEL`       | `claude-sonnet-5`  | Model for the Max-tier invoice scanner. It runs on Sonnet (extraction quality) rather than Haiku.             |
| `INVOICE_SCAN_MONTHLY_CAP` | `100`              | Scans per user per calendar month on the platform key. Metered by scan count, not tokens; BYOK is uncapped.   |

## Connect Claude (MCP)

Connect **Claude Desktop** or **Claude Code** to your own instance and ask about your projects in
plain language — _"which project has the best effective hourly rate?"_, _"log €600 against Acme
for last Tuesday"_. This is the free / self-host tier of the assistant: your data inside Claude's
app, using your own Claude subscription. vorhaben ships no keys and makes no LLM calls for it.

The `mcp/` workspace is a small stdio server that adapts the REST API into MCP tools. It logs in
with your account and reuses the same session as the web app, so it inherits auth, per-user
scoping, and the normalization engine — the figures it returns are computed server-side, never
re-derived. Add this to Claude Desktop's `claude_desktop_config.json` (or a `.mcp.json` for Claude
Code):

```json
{
  "mcpServers": {
    "vorhaben": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/vorhaben/mcp/src/index.ts"],
      "env": {
        "VORHABEN_API_URL": "http://localhost:4001",
        "VORHABEN_EMAIL": "you@example.com",
        "VORHABEN_PASSWORD": "your-password"
      }
    }
  }
}
```

Read tools are pull-only; write tools (add income/expense, log time, create notes/reminders, log
mood) are confirmed by the Claude client before they run. Full tool list, env vars, and the Docker
self-host port note are in [`.claude/docs/backend/mcp.md`](.claude/docs/backend/mcp.md).

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

| Script                     | Description                            |
| -------------------------- | -------------------------------------- |
| `npm run dev`              | Run client and server in watch mode    |
| `npm run build`            | Build client and server for production |
| `npm run lint`             | Lint client and server                 |
| `npm run format`           | Format the repo with Prettier          |
| `npm run typecheck`        | Type-check client and server           |
| `npm run migrate`          | Run database migrations                |
| `npm run migrate:rollback` | Roll back the last migration batch     |

## Documentation

Deeper docs live in `.claude/docs/`:

- [`backend/data-model.md`](.claude/docs/backend/data-model.md) — every table, columns, indexes, FKs.
- [`backend/api.md`](.claude/docs/backend/api.md) — the full HTTP API, grouped by resource, with curl examples.
- [`backend/normalization.md`](.claude/docs/backend/normalization.md) — how revenue and hourly-rate figures are computed.
- [`backend/mcp.md`](.claude/docs/backend/mcp.md) — the MCP server: connecting Claude Desktop / Claude Code, tools, and env vars.

The full product spec lives in [`BUSINESS_LOGIC.md`](./BUSINESS_LOGIC.md).

## Contributing

Issues and pull requests are welcome. This project is early-stage — expect the structure to
evolve.

## License

[MIT](./LICENSE)
