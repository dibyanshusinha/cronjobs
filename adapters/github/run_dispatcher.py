"""GitHub Actions entrypoint. Wires GitHub-specific adapters (JSON state on
the cron-state branch, git commits, GitHub Issues) around the GitHub-agnostic
core (engine.dispatch), and decides exactly when to commit:

  1. plan()   -> commit "claim" (state/dedup.json + any skip-history writes)
  2. execute()-> commit "finalize" (cursors/dedup/issues + history + dashboard)

If step 1's commit never happens because the process dies, nothing has
executed yet, so there's nothing to reconcile. If the process dies between
step 1 and step 2, the next run's reconcile_stale_claims() (called at the top
of plan()) cleans up the claim rather than silently re-firing it.

Invoked as `python -m adapters.github.run_dispatcher` from the repo root,
with STATE_DIR pointing at a checkout/worktree of the cron-state branch.
"""
from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from engine import dashboard, discovery, dispatch, schema
from engine.history import HistoryStore
from engine.ledger import Ledger
from engine.state_backend import JsonFileStateBackend

from .git_branch_state import GitCommitter
from .issues_notifier import GitHubIssuesNotifier

REPO_ROOT = Path(__file__).resolve().parents[2]
SITE_SOURCE = Path(__file__).resolve().parent / "site"


def _env_bool(name: str, default: bool = False) -> bool:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    return val.strip().lower() in ("1", "true", "yes")


def sync_site_shell(state_dir: Path) -> None:
    """Copy the static dashboard shell (rarely changes) alongside the
    generated dashboard-data/summary.json inside the cron-state checkout, so
    GitHub Pages (serving cron-state:/docs) has everything it needs from one
    branch."""
    docs_dir = state_dir / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    for item in SITE_SOURCE.iterdir():
        shutil.copy2(item, docs_dir / item.name)


def main() -> int:
    state_dir = Path(os.environ["STATE_DIR"]).resolve()
    token = os.environ["GITHUB_TOKEN"]
    repo = os.environ["GITHUB_REPOSITORY"]
    job_id = os.environ.get("JOB_ID") or None
    force_disabled = _env_bool("FORCE_DISABLED")
    max_concurrency = int(os.environ.get("MAX_CONCURRENCY", "5"))

    backend = JsonFileStateBackend(state_dir)
    ledger = Ledger(backend)
    ledger.load()
    history = HistoryStore(backend)
    committer = GitCommitter(state_dir)
    now = datetime.now(timezone.utc)

    try:
        jobs = discovery.discover_jobs(REPO_ROOT / "jobs")
    except (discovery.DiscoveryError, schema.ValidationError) as e:
        print("Job validation failed — dispatcher not running this tick:", file=sys.stderr)
        print(str(e), file=sys.stderr)
        ledger.record_heartbeat(now, "validation_failed", detail=str(e))
        ledger.flush(only={"state/heartbeat"})
        committer.commit_and_push(["."], f"chore: heartbeat (validation failed) @ {now.isoformat()}")
        return 1

    notifier = GitHubIssuesNotifier(ledger, repo, token)

    try:
        planned = dispatch.plan(jobs, ledger, history, now, job_id=job_id, force_disabled=force_disabled)
    except dispatch.DispatchError as e:
        print(f"Dispatch error: {e}", file=sys.stderr)
        return 1

    # Checkpoint 1: claim, before anything executes.
    ledger.flush(only={"state/dedup"})
    committer.commit_and_push(
        ["."], f"chore: claim {len(planned.to_run)} occurrence(s) @ {now.isoformat()}"
    )

    summary = dispatch.execute(planned, ledger, history, notifier, REPO_ROOT, max_concurrency=max_concurrency)

    # Regenerate dashboard data + sync the (rarely-changing) static shell.
    summary_data = dashboard.build_summary(jobs, ledger, history, now)
    backend.save("docs/dashboard-data/summary", summary_data)
    sync_site_shell(state_dir)

    # Checkpoint 2: finalize.
    ledger.flush()
    committer.commit_and_push(
        ["."],
        f"chore: dispatcher run @ {now.isoformat()} — {len(summary.ran)} executed, "
        f"{summary.skipped_count} skipped",
    )

    failed = sum(1 for r in summary.ran if r.status == "failed")
    print(
        f"Dispatcher run complete: {len(summary.ran)} executed ({failed} failed), "
        f"{summary.skipped_count} skipped, {len(summary.stale_claims_reconciled)} stale claim(s) reconciled."
    )
    # The dispatcher's own exit code reflects whether it *ran*, not whether
    # individual jobs succeeded — job failures are surfaced via GitHub Issues
    # and the dashboard, not by failing this Action (which would just be noise
    # on every transient ping failure).
    return 0


if __name__ == "__main__":
    sys.exit(main())
