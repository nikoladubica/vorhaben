# vorhaben

Track and manage your business endeavours — an open-source project tracker for founders juggling
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

## Getting started

### Prerequisites

- Node.js >= 20
- Docker (for local MariaDB), or a MariaDB instance you already have running

### Setup

```bash
cp .env.example .env
npm install

# start a local MariaDB
docker compose up -d

# run migrations
npm run migrate

# start client + server in dev mode
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:4000 (proxied under `/api` from the client dev server)

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

## Contributing

Issues and pull requests are welcome. This project is early-stage — expect the structure to
evolve.

## License

[MIT](./LICENSE)
