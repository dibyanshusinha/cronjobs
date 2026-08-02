# Release Notes

## v1.0.0

### Overview

`cronjobs` v1.0.0 is the initial public release of a cron-job.org-style
dispatcher for scheduled HTTP requests and scripts. It supports two deployment
modes that share the same Node.js core engine:

- GitHub-native mode using GitHub Actions, GitHub Issues, and GitHub Pages.
- Standalone mode using Docker Compose, SQLite, and an authenticated local
  dashboard/API.

### Highlights

- Recursive job discovery from `jobs/**/*.job.yml`.
- Folder-level `_defaults.yml` inheritance.
- Schema validation and duplicate job ID detection.
- Cron scheduling with timezone support and cursor-based catch-up.
- Misfire policies for missed occurrences.
- HTTP jobs with expected-status validation and bounded response handling.
- Script jobs with path, symlink, and interpreter restrictions.
- Retry, timeout, deduplication, history, heartbeat, and dashboard summaries.
- Shared `StateBackend` contract for JSON-file and SQLite state storage.
- Backup and restore commands for standalone deployments.

### GitHub Deployment

GitHub mode runs from the `Dispatch cron jobs` workflow every five minutes. It
stores generated operational state on the `cron-state` branch and publishes the
static dashboard from `cron-state:/docs`.

Use this mode only for public, non-sensitive jobs. A public repository exposes
job names, schedules, URLs, script source, dashboard data, and execution history.

### Standalone Deployment

Standalone mode runs with Docker Compose on a Linux server, VPS, or local
machine. It provides:

- internal scheduler loop;
- SQLite state/history storage;
- authenticated dashboard and API;
- mounted `jobs/` and `scripts/` directories;
- `.env`, Docker secrets, or mounted secret-file support;
- optional webhook notifications.

It has no runtime dependency on GitHub Actions, GitHub Pages, GitHub Issues, or
the GitHub API.

### Security Improvements

- Public/private deployment guidance in README and self-hosted docs.
- Script path traversal and symlink escape protection.
- Interpreter allowlist for script jobs.
- No inline shell commands in job YAML.
- HTTP redirect avoidance and response-size limits.
- Redaction of likely secret environment values in history details.
- No full HTTP response bodies, request headers, credentials, or script output
  stored in dashboard history.
- Standalone dashboard/API authentication with Basic or Bearer credentials.
- Docker Compose binds the dashboard to `127.0.0.1` by default.
- Runtime data, `.env`, SQLite files, backups, and secret files are ignored.

### Breaking Changes

None. This is the initial release.

### Upgrade Notes

No upgrade path is required for the initial release.

For standalone deployments, keep private jobs, scripts, `.env`, and `data/`
outside the image as mounted runtime data. Stop the service before restoring
backend state data.

### Known Limitations

- GitHub scheduled workflows are best-effort and have a five-minute cadence.
- Standalone storage currently supports SQLite only.
- `node:sqlite` emits an experimental warning; Node is pinned to `24.13.1`.
- Notification adapters are limited to GitHub Issues and standalone webhook/log.
- The dashboard can display and control jobs, but first-class private job
  management remains future work.

### Roadmap

v1.1:

- richer standalone dashboard controls;
- more notification adapters;
- import-from-curl;
- per-job run-now UI.

v2.0:

- PostgreSQL state backend;
- multi-user authentication;
- encrypted secret store;
- first-class private job management UI.
