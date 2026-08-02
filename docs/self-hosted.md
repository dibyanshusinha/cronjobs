# Self-Hosted Deployment

The standalone edition runs the same scheduler, job loader, schema validation, HTTP executor,
script executor, retry policy, misfire handling, deduplication, history model, and dashboard
summary logic as the GitHub Actions edition. GitHub-specific pieces are not required at runtime.

## What It Runs

- Node 24.13.1 standalone HTTP server
- Internal scheduler loop
- SQLite state and history store
- Authenticated dashboard and API
- Mounted `jobs/` and `scripts/` directories
- Optional notification webhook

The service does not call GitHub Actions, GitHub Pages, GitHub Issues, or the GitHub API.
Node is pinned to 24.13.1 in `package.json` and the Docker image. The SQLite adapter uses
Node's built-in `node:sqlite` module, which is currently experimental, so keep the pinned Node
version until the SQLite behavior is deliberately retested on a newer runtime.
Standalone state storage is selected with `STATE_BACKEND`; `sqlite` is the only enabled value
today. Future database backends can be added behind the shared state backend contract without
changing scheduler, ledger, history, or dashboard code.

## Quick Start

```bash
cp .env.example .env
```

Edit `.env` and set a strong `DASHBOARD_PASSWORD` or `DASHBOARD_TOKEN`.

```bash
docker compose up -d --build
```

Open:

```text
http://127.0.0.1:8080/
```

The default compose file binds only to `127.0.0.1`. Put it behind a reverse proxy with TLS if
you want remote access.

## Mounted Runtime Data

```text
jobs/       read-only job definitions
scripts/    read-only script files
data/       SQLite database and runtime state
.env        local deployment settings and secrets
```

Do not commit private jobs, private scripts, `.env`, `data/`, SQLite files, or backups.

## Secrets

The HTTP executor resolves header values like:

```yaml
headers:
  Authorization: ${MY_API_TOKEN}
```

The standalone service can load secrets from:

- `.env` through Docker Compose `env_file`
- Docker secrets mounted under `/run/secrets`
- any directory configured with `SECRETS_DIR`

Secret file names are converted to uppercase environment names. For example
`/run/secrets/my_api_token` becomes `MY_API_TOKEN`.

## API

Health endpoints do not require authentication:

```text
GET /healthz
GET /readyz
```

Authenticated endpoints:

```text
GET /dashboard-data/summary.json
GET /api/jobs
POST /api/jobs/:jobId/run
PATCH /api/jobs/:jobId
```

Manual run body:

```json
{
  "force_disabled": false
}
```

Enable or disable a job without editing mounted YAML:

```json
{
  "enabled": false
}
```

The enable/disable override is stored in SQLite. The job YAML can remain read-only.

## Backup

Create a backup:

```bash
npm run standalone:backup -- ./backups/manual-$(date +%Y%m%d)
```

The backup contains:

- `jobs/`
- `scripts/`
- `data/cronjobs.sqlite`
- `manifest.json`

Restore:

```bash
npm run standalone:restore -- ./backups/manual-20260802
```

Stop the Docker service before restoring backend state data.

## Upgrade

```bash
git pull
docker compose up -d --build
```

Keep private jobs and runtime data in mounted directories so upgrades do not bake secrets into
the image.

## Security Notes

- Set `DASHBOARD_PASSWORD` or `DASHBOARD_TOKEN`.
- `ALLOW_NO_AUTH=true` is development-only.
- Any non-loopback dashboard exposure must require authentication.
- Keep Compose bound to `127.0.0.1` unless a reverse proxy handles TLS and authentication.
- Mount `jobs/` and `scripts/` read-only.
- Script jobs can run code from `scripts/`; only grant write access to trusted users.
- The dashboard stores sanitized summaries, not full response bodies.
- Scheduled HTTP calls come from the server running this container, not GitHub Actions.
