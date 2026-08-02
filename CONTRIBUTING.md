# Contributing

Thanks for helping improve `cronjobs`.

## Development Setup

```bash
npm install
npm run validate
npm test
npm audit
docker compose config
```

Use Node.js `24.13.1`, matching `package.json`, the Docker image, and GitHub
Actions.

## Before Opening A Pull Request

- Keep job examples public and non-sensitive.
- Do not commit `.env`, private URLs, credentials, SQLite files, `data/`,
  backups, or generated `cron-state` output.
- Add or update tests for behavior changes.
- Keep GitHub-specific code under `src/adapters/github/`.
- Keep standalone-specific code under `src/adapters/standalone/`.
- Keep shared scheduling, discovery, execution, ledger, history, and dashboard
  behavior in `src/engine/`.

## Pull Request Checklist

- `npm test` passes.
- `npm run validate` passes.
- `npm audit` reports no vulnerabilities.
- `docker compose config` is valid.
- Documentation is updated when behavior, configuration, or deployment changes.

## Security-Sensitive Changes

Changes touching script execution, HTTP execution, secret resolution,
authentication, state persistence, backup/restore, or public dashboard data need
extra care. Document the threat model and include focused tests.
