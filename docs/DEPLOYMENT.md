# Deploying DHYEYA

One container serves the API and the built web client on port 4000. Data (SQLite file and uploaded workbooks) lives on the `/data` volume.

## 1. Docker Compose (recommended)

```bash
cp .env.example .env
# edit .env: set JWT_SECRET and BOOTSTRAP_ADMIN_PASSWORD (both are required)
docker compose up -d --build
docker compose logs -f dhyeya
```

On every start the container runs `migrate` (idempotent), `seed` (creates the system categories and the first administrator only if absent), then the server. Open `http://<host>:4000` and sign in as `BOOTSTRAP_ADMIN_EMAIL` with `BOOTSTRAP_ADMIN_PASSWORD`.

Health check: `GET /api/health` returns `{"status":"ok"}` (used by the container `HEALTHCHECK`).

### PostgreSQL instead of SQLite

```bash
# add POSTGRES_PASSWORD to .env, then
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

## 2. Without Docker

```bash
cd client && npm ci && npm run build
cd ../server && npm ci && npm run build
export NODE_ENV=production JWT_SECRET=... BOOTSTRAP_ADMIN_PASSWORD=...
node dist/db/cli.js migrate && node dist/db/cli.js seed
node dist/index.js
```

Run it under a process manager (systemd, pm2) and keep `server/data` and `server/storage` (or `SQLITE_FILE` / `UPLOAD_DIR`) on persistent, backed-up storage.

## Production checklist

- **TLS is required.** Put the app behind a reverse proxy (Caddy, nginx, a cloud load balancer) that terminates HTTPS. In production the session cookie is `Secure` and Helmet sends HSTS and `upgrade-insecure-requests`, so plain `http://` access (other than some `localhost` cases) will not keep a login. The app already trusts one proxy hop (`trust proxy = 1`).
- Set `CORS_ORIGIN` to the public URL (for example `https://dhyeya.example.com`).
- `JWT_SECRET` must be a long random value; the server refuses to start in production with the default.
- The seeded admin must change the password at first sign-in. Pick a strong `BOOTSTRAP_ADMIN_PASSWORD`; do not use the documented dev default.
- **Back up** the `/data` volume (SQLite file + uploads) or your Postgres database. The data is financial.
- Optional integrations (AI, CRM, SMTP) stay "not configured" unless their variables are set; see `server/.env.example`.

## Updating

```bash
git pull && docker compose up -d --build
```

Migrations are applied automatically at startup; the volume is preserved.

## Status of this setup

The Docker files were written against the project's scripts and source but have **not been built or run** in the environment where they were authored (that machine blocks the Node build tools). Run `docker compose build` once and check `docker compose logs` before relying on it.
