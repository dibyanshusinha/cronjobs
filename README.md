# cronjobs

A GitHub-native alternative to cron-job.org for public, non-sensitive jobs.
Define cron jobs as YAML files; a GitHub Actions workflow polls every 5 minutes
and runs whatever is due; results show up on a GitHub Pages dashboard and
failures open a GitHub Issue.

The dispatcher is now a Node.js project, so local development uses `npm`
instead of Python tooling.

## Is this the right fit for your job?

**This edition is public.** It's built to run in a public GitHub repo so Actions
minutes are unlimited/free. That means:

- Job names, URLs, schedules, and script contents are visible to anyone.
- GitHub Secrets keep secret values hidden. You can reference `${MY_SECRET}` in
  an HTTP job's headers and substitute it at execution time, but the job's
  existence, target URL, and schedule are still public.
- Do not put internal hostnames, private admin endpoints, private scripts, or
  sensitive execution metadata in this public repo.

If your jobs themselves need secrecy, use this repository only as the public
runner/software project and keep private jobs in a future standalone deployment.

## Architecture

```text
src/engine/       core scheduling, validation, executors, retry/history logic
src/adapters/     GitHub-specific runtime glue
adapters/github/site/
                  static dashboard shell copied to cron-state:/docs
```

The core does not import GitHub-specific code. It depends on small interfaces:

- a JSON-like state backend, currently `JsonFileStateBackend`;
- a notification adapter, currently GitHub Issues.

This split keeps the scheduler, job discovery, executors, and dashboard data
generation reusable for a future self-hosted Docker/SQLite mode.

## The `cron-state` branch

GitHub Actions runners are ephemeral, so dispatcher state must be persisted
somewhere. Generated state lives on a separate **`cron-state`** branch:

```text
state/*.json
history/*.json
docs/dashboard-data/summary.json
docs/index.html
docs/app.js
docs/styles.css
```

The dispatcher never commits operational state to `main`.

GitHub Pages should serve from:

```text
Branch: cron-state
Folder: /docs
```

## Two-phase commit

Each run commits twice:

1. Claim due occurrences before executing any job.
2. Finalize dedup state, cursors, history, heartbeat, issues, and dashboard data
   after execution finishes.

If a runner dies after the claim commit, the next run reconciles stale claims
instead of silently firing an occurrence twice.

## Catch-up, not exact timing

GitHub's scheduled workflow trigger is best-effort and can start late. The
dispatcher tracks a per-job cursor and computes every cron occurrence that
became due since the last evaluated time. This is why delayed ticks do not
silently drop jobs.

## Setup

1. Create the repo as public on GitHub and push `main`.
2. Trigger **Dispatch cron jobs** manually once so the workflow creates
   `cron-state`.
3. Enable Pages from `cron-state` / `/docs`.

The example jobs do not need extra secrets. `GITHUB_TOKEN` is provided
automatically by Actions with the workflow permissions already configured.

## Adding a job

Create a file under `jobs/` ending in `.job.yml`.

```yaml
id: my-unique-job-id
name: "Human-readable name"
schedule: "*/10 * * * *"
type: http
http:
  url: "https://example.com/ping"
  expected_status: [200]
```

Nested folders are supported and are only for organization.

The dashboard includes a **Create job** helper. It opens as a focused dialog so
the monitoring view stays clean. It lets you fill out the fields, add HTTP
headers, skip selected weekdays, set job timeouts and failure safeguards,
generate copy-ready YAML, simulate upcoming run times, and test a public HTTP
request directly from your browser after an explicit confirmation. The YAML
stays collapsed behind a preview because the normal path is to use the copy
button. The browser test is useful when you want the receiving service to see
your current browser/network IP instead of a GitHub Actions runner IP.

Scheduled jobs still run from GitHub Actions, so production executions will
come from GitHub-hosted runner infrastructure unless you later move the job to a
self-hosted runner or standalone deployment. Do not rely on spoofed headers such
as `X-Forwarded-For` for identity; the real source IP is decided by where the
request is executed.

## Defaults inheritance

Add `_defaults.yml` in any folder under `jobs/` to set defaults for that folder
and its subfolders. Deeper defaults override shallower defaults, and a job's own
fields override all defaults.

Allowed default keys:

```text
timezone
enabled
retries
retry_backoff_seconds
timeout_seconds
misfire_policy
misfire_cap
history_limit
history_retention_days
failure_policy
notify
```

Identity and job-specific execution fields such as `id`, `schedule`, `type`,
`http`, and `script` must be set per job.

## Referencing a secret in an HTTP job

Header values of the exact form `${VAR_NAME}` are substituted from the process
environment at execution time:

```yaml
http:
  url: "https://example.com/webhook"
  headers:
    Authorization: "${MY_WEBHOOK_TOKEN}"
```

Add `MY_WEBHOOK_TOKEN` as a repo secret and pass it through in
`.github/workflows/dispatcher.yml` for the "Run dispatcher" step. The value is
never logged or stored in history.

## Misfire policy

If the dispatcher is delayed and a job's schedule fired multiple times since it
was last checked:

- `most_recent` runs only the latest missed occurrence and records older ones as
  `skipped`.
- `all` runs every missed occurrence, capped by `misfire_cap`.

## Manual runs

Actions tab -> **Dispatch cron jobs** -> **Run workflow** -> enter `job_id`.

Manual runs bypass the schedule but not the `enabled` flag. Running a disabled
or auto-disabled job requires `force_disabled`.

## Failure backoff and auto-disable

Each job has a failure policy. Defaults are intentionally conservative:

```yaml
failure_policy:
  auto_disable_after_consecutive_failures: 5
  initial_backoff_seconds: 300
  backoff_multiplier: 2
  max_backoff_seconds: 21600
```

When a job fails, future automatic runs pause with exponential backoff. After
the configured consecutive-failure threshold, the job is auto-disabled so the
runner stops calling an endpoint that may be broken, rate-limited, or rejecting
requests.

Manual runs can still be used to test recovery. If a job is auto-disabled, use
`force_disabled` explicitly. A successful run clears the failure pause and
auto-disable state.

The dashboard shows `paused` and `disabled` states separately.

## History display and cleanup

Recent history is shown inside each expandable job card with pagination so long
failure or skip streaks do not overwhelm the page. The dashboard summary
publishes a capped recent slice per job, while full archived history continues
to be stored under `history/archive/YYYY-MM/` on the `cron-state` branch.
Archive cleanup follows each job's `history_retention_days` setting.

## Script jobs

`script.path` must point to a repo-relative file under `scripts/`, for example:

```yaml
type: script
script:
  path: scripts/examples/backup_check.sh
  interpreter: bash
  args: ["--verbose"]
```

Security rules:

- no inline shell commands;
- no absolute paths;
- no `..` traversal;
- no symlink escape;
- only `bash`, `python3`, and `node` interpreters are allowed;
- stdout/stderr are not stored in history.

## Redaction

Public history and dashboard data never contain:

- HTTP response bodies or headers;
- script stdout/stderr;
- request headers;
- credentials or Authorization values.

Stored detail strings are capped at 300 characters.

## History storage and cleanup

The dashboard reads a small recent-history file per job so the UI stays fast.
The dispatcher also writes month-based archive files under:

```text
history/archive/YYYY-MM/<job-id>.json
```

Those archive files live on the `cron-state` branch with the rest of the
generated state. `history_retention_days` controls cleanup of old archive
entries; the default is 365 days. Git itself still preserves prior committed
state in repository history until you intentionally rewrite or prune it.

## Local development

```bash
npm install
npm run validate
npm test
```

To run the GitHub adapter locally, point `STATE_DIR` at a temporary checkout or
scratch directory. Do not point it at `main`:

```bash
STATE_DIR=.local-state \
GITHUB_TOKEN=dummy \
GITHUB_REPOSITORY=owner/repo \
npm run dispatch:github
```

The real GitHub workflow prepares a `cron-state` worktree before running the
dispatcher.

## Self-hosted mode

Self-hosted mode is designed for but not built yet. The Node core under
`src/engine/` is GitHub-independent, so a future Docker Compose deployment can
reuse the same job schema, scheduler, discovery, validation, executors, retry
logic, and dashboard data model.

That future mode should supply its own state backend, likely SQLite, and its
own notifier/web UI instead of depending on GitHub Actions, GitHub Pages, or
GitHub Issues at runtime.
