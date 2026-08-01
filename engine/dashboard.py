"""Builds the dashboard data structure. Pure function of (jobs, ledger, history,
now) — no file I/O to docs/ or anywhere else. The GitHub Pages adapter is what
decides where this dict gets written; a future self-hosted dashboard server
could serve the same dict directly over HTTP instead.
"""
from __future__ import annotations

from datetime import datetime

from . import scheduler
from .history import HistoryStore
from .ledger import Ledger
from .models import Job
from .timeutil import iso


def build_summary(jobs: list[Job], ledger: Ledger, history: HistoryStore, now: datetime) -> dict:
    job_entries = []
    failing = 0
    for job in sorted(jobs, key=lambda j: j.id):
        cursor = ledger.cursors.get(job.id, {})
        consecutive_failures = cursor.get("consecutive_failures", 0)
        if consecutive_failures > 0:
            failing += 1
        try:
            next_due = iso(scheduler.next_due_after(job.schedule, job.timezone, now))
        except Exception:
            next_due = None

        recent = history.recent(job.id, limit=10)
        # The cursor only advances for scheduled (non-manual) occurrences, so a
        # job that's only ever been run manually would otherwise show as
        # "never run" — prefer the most recent real history entry when present.
        last_real = next((r for r in reversed(recent) if r.get("status") != "skipped"), None)
        last_run_at = last_real["finished_at"] if last_real else cursor.get("last_evaluated_utc")
        last_status = last_real["status"] if last_real else cursor.get("last_status")

        job_entries.append(
            {
                "id": job.id,
                "name": job.name,
                "type": job.type,
                "enabled": job.enabled,
                "schedule": job.schedule,
                "timezone": job.timezone,
                "last_evaluated_utc": last_run_at,
                "last_status": last_status,
                "consecutive_failures": consecutive_failures,
                "next_due_utc": next_due,
                "open_issue": ledger.open_issue_number(job.id),
                "recent_history": recent,
            }
        )
    return {
        "generated_at": iso(now),
        "heartbeat": ledger.heartbeat,
        "jobs": job_entries,
        "meta": {"total_jobs": len(jobs), "failing_jobs": failing},
    }
