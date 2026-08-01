"""Retry/backoff/timeout wrapper shared by both job types. Dispatches to the
right executor by job.type; the caller (engine.dispatch) doesn't need to know
the difference.
"""
from __future__ import annotations

import time
from datetime import datetime
from datetime import timezone as dt_timezone
from pathlib import Path

from ..models import Job, RunResult
from ..timeutil import iso
from . import http_executor, script_executor


def run_with_retry(job: Job, scheduled_time: datetime, repo_root: Path) -> RunResult:
    started = datetime.now(dt_timezone.utc)
    scheduled_iso = iso(scheduled_time)
    max_attempts = job.retries + 1
    ok = False
    detail = ""
    attempts = 0

    for attempt in range(1, max_attempts + 1):
        attempts = attempt
        try:
            if job.type == "http":
                ok, detail = http_executor.execute(job.id, scheduled_iso, job.http)
            else:
                ok, detail = script_executor.execute(job.id, job.script, repo_root)
        except Exception as e:  # defense in depth: an executor must never crash the dispatcher
            ok, detail = False, f"executor error: {type(e).__name__}"

        if ok or attempt == max_attempts:
            break
        time.sleep(job.retry_backoff_seconds * (2 ** (attempt - 1)))

    finished = datetime.now(dt_timezone.utc)
    return RunResult(
        job_id=job.id,
        scheduled_time=scheduled_iso,
        status="success" if ok else "failed",
        started_at=iso(started),
        finished_at=iso(finished),
        duration_ms=int((finished - started).total_seconds() * 1000),
        attempts=attempts,
        detail=detail,
    )
