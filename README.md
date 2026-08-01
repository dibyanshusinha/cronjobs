# cronjobs

A self-hosted alternative to cron-job.org that runs entirely on GitHub — no
third-party service, no cost. Define jobs as YAML files; a GitHub Actions
workflow polls every 5 minutes and runs whatever's due; results show up on a
GitHub Pages dashboard and failures open a GitHub Issue.

## Is this the right fit for your job?

**This edition is public.** It's built to run in a public GitHub repo (so
Actions minutes are unlimited/free — a private repo's 2,000 free minutes/month
would be exhausted by 5-minute polling). That means:

- Job names, URLs, schedules, and script contents are all visible to anyone.
- GitHub Secrets keep secret *values* hidden — you can reference
  `${MY_SECRET}` in an HTTP job's headers and it's substituted at execution
  time, never committed in plaintext — but the job's existence, its target
  URL, and its schedule are still public.
- Don't put anything here you wouldn't want publicly known: internal
  hostnames, non-obvious admin endpoints, etc.

If your jobs themselves need to be private, this isn't the right mode for
them — see [Self-hosted mode](#self-hosted-mode-designed-for-not-built) below.

## Architecture

```
engine/      core — scheduling, validation, executors, retry/history logic.
             Zero GitHub-specific imports. Fully unit-testable (tests/) with
             no network access and no GitHub Actions needed.
adapters/    GitHub-specific glue: git commits to the cron-state branch,
             GitHub Issues notifications, the Pages dashboard shell.
```

The core depends on two small interfaces (`engine/state_backend.py`'s
`StateBackend`, `engine/notify.py`'s `Notifier`) instead of talking to git or
GitHub Issues directly. `adapters/github/` supplies the concrete
implementations for this edition. This split exists so a different backend —
e.g. SQLite for a self-hosted deployment — can be swapped in later without
touching `engine/`.

### The `cron-state` branch

Every dispatcher run needs to persist state somewhere (GitHub Actions runners
are ephemeral). Rather than committing that to `main` — which would bury real
commits under thousands of automated ones — all generated state
(`state/*.json`, `history/*.json`, `docs/dashboard-data/summary.json`) lives
on a separate **`cron-state`** branch that the workflow creates automatically
on first run. `main` is never touched by the dispatcher.

GitHub Pages should be configured to serve from `cron-state:/docs` (see
Setup below) — the dashboard's static shell (`adapters/github/site/`) is
copied there by every run alongside the generated data, so Pages only needs
to watch one branch.

### Two-phase commit

Each run commits twice: once right after deciding what's due and claiming it
(before anything executes), and once after execution finishes. If the runner
is killed between those two commits, the next run finds the claim already
made and treats it as an abandoned attempt rather than silently re-firing a
job that may have already run — see `engine/ledger.py`'s
`reconcile_stale_claims`.

### Catch-up, not "exactly every 5 minutes"

GitHub's `schedule` trigger is best-effort and can lag under load. Each job
tracks a "last evaluated" cursor; every run computes every cron occurrence
that became due since that cursor, not just "is it due right now" — so a
delayed or occasionally-skipped tick doesn't silently drop a run. See
`misfire_policy` below for what happens when several occurrences pile up at
once.

### Heartbeat

The dashboard shows when the dispatcher itself last ran (separate from any
individual job's status) — that's `state/heartbeat.json`, updated
unconditionally on every tick. If that timestamp goes stale, the dispatcher
itself has stopped running (check the Actions tab).

## Setup

1. **Create the repo as public** on GitHub and push this code to `main`.
2. **Enable GitHub Pages**: Settings → Pages → Source: "Deploy from a
   branch" → Branch: `cron-state` / `/docs`. The `cron-state` branch is
   created automatically the first time the dispatcher workflow runs, so
   trigger it once manually first (Actions tab → "Dispatch cron jobs" →
   "Run workflow") before configuring Pages.
3. That's it — no extra secrets needed for the two example jobs.
   `GITHUB_TOKEN` is provided automatically by Actions with `contents: write`
   + `issues: write` (already set in the workflow's `permissions:` block).

## Adding a job

Create a file under `jobs/` ending in `.job.yml`, anywhere in the tree —
nested folders are fine and are just for your own organization.

```yaml
id: my-unique-job-id       # required, globally unique, stable across moves
name: "Human-readable name"
schedule: "*/10 * * * *"    # standard 5-field cron
type: http                  # or: script
http:
  url: "https://example.com/ping"
  expected_status: [200]
```

Push it (or open a PR — `.github/workflows/validate.yml` checks schema,
duplicate IDs, and script-path safety on every push/PR touching `jobs/**`,
before anything ever runs).

### Defaults inheritance

Drop a `_defaults.yml` in any folder under `jobs/` to set defaults for every
job in that folder and its subfolders. Deeper `_defaults.yml` files override
shallower ones; a job's own fields always win. Allowed default keys:
`timezone`, `enabled`, `retries`, `retry_backoff_seconds`, `timeout_seconds`,
`misfire_policy`, `misfire_cap`, `history_limit`, `notify`. (Not `id`,
`schedule`, `type`, `http`, `script` — those must always be set per-job.)

### Referencing a secret in an HTTP job

Header values of the exact form `${VAR_NAME}` are substituted from the
environment at execution time:

```yaml
http:
  url: "https://example.com/webhook"
  headers:
    Authorization: "${MY_WEBHOOK_TOKEN}"
```

Add `MY_WEBHOOK_TOKEN` as a repo secret and pass it through in
`.github/workflows/dispatcher.yml`'s `env:` block for the "Run dispatcher"
step. The value is never logged or stored in history.

### `misfire_policy`

If the dispatcher is delayed and a job's schedule fired multiple times
since it was last checked:

- `most_recent` (default): only the latest missed occurrence runs; the rest
  are recorded as `skipped` in history (visible, not silently dropped).
- `all`: every missed occurrence runs, capped by `misfire_cap` (default 10)
  as a safety valve against a huge backlog.

### Running a job manually

Actions tab → "Dispatch cron jobs" → "Run workflow" → fill in `job_id`. This
bypasses the schedule entirely (runs immediately) but **not** the `enabled`
flag — running a disabled job also requires checking `force_disabled`.

### Script jobs

`script.path` must point to a file under `scripts/` (repo-relative, e.g.
`scripts/examples/backup_check.sh`) — no inline commands, no path traversal,
no symlinks out of `scripts/`, and only `bash`/`python3`/`node` may run it.
These checks run both at validate-time (PR-time) and execute-time.

## What's redacted, and why

Public history and the dashboard never contain:

- HTTP response bodies or headers (only status code + pass/fail + timing)
- Script stdout/stderr (only exit code + timing) — a script could easily
  echo a secret from its environment by accident, so this is a deliberate v1
  simplification rather than an oversight
- Request headers, credentials, or Authorization values

Every stored "detail" string is hard-capped at 300 characters regardless.

## Local development

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
python -m engine.validate_cli     # validate jobs/ without executing anything
python -m pytest tests/ -q        # scheduler, discovery, ledger, script/HTTP security
```

## Self-hosted mode (designed-for, not built)

`engine/` has no GitHub-specific imports by design, so a future Docker
Compose deployment — its own internal scheduler, mounted private `jobs/` and
`scripts/` directories, `.env`/Docker secrets, SQLite persistence, an
authenticated dashboard, no dependency on GitHub Actions/Pages/Issues — can
reuse the same job schema, `engine/scheduler.py`, `engine/executors/`,
`engine/dispatch.py`, and `engine/history.py` unchanged. It would supply its
own `StateBackend` (e.g. SQLite instead of `JsonFileStateBackend`) and
`Notifier` (e.g. a webhook instead of `GitHubIssuesNotifier`). That mode
isn't implemented yet — only the seam for it is.
