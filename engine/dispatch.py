"""Pure orchestration, split into plan() and execute() so a GitHub-specific
adapter can commit state to the cron-state branch *between* them (claim
committed before anything executes, finalize committed after) — see
adapters/github/run_dispatcher.py. Neither function touches git, files
outside a StateBackend, or anything else GitHub-specific.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from . import scheduler
from .concurrency import run_bounded
from .executors.base import run_with_retry
from .history import HistoryStore
from .ledger import Ledger
from .models import Job, RunResult
from .notify import Notifier
from .timeutil import iso


class DispatchError(Exception):
    pass


@dataclass
class PlannedRun:
    now: datetime
    to_run: list[tuple[Job, datetime, bool]] = field(default_factory=list)
    evaluated_job_ids: set = field(default_factory=set)
    prior_failures: dict = field(default_factory=dict)
    skipped_count: int = 0
    stale_claims_reconciled: list = field(default_factory=list)


@dataclass
class DispatchSummary:
    now: datetime
    ran: list[RunResult] = field(default_factory=list)
    skipped_count: int = 0
    stale_claims_reconciled: list = field(default_factory=list)


def plan(
    jobs: list[Job],
    ledger: Ledger,
    history: HistoryStore,
    now: datetime,
    job_id: Optional[str] = None,
    force_disabled: bool = False,
) -> PlannedRun:
    """Figure out what's due and claim it. Nothing executes yet. Callers should
    persist state/dedup (and ideally commit it) right after calling this and
    before calling execute() — that's the safety boundary an interrupted run
    relies on."""
    stale = ledger.reconcile_stale_claims(now)

    to_run: list[tuple[Job, datetime, bool]] = []
    evaluated_job_ids: set = set()
    skipped_count = 0

    if job_id is not None:
        job = next((j for j in jobs if j.id == job_id), None)
        if job is None:
            raise DispatchError(f"unknown job id '{job_id}'")
        if not job.enabled and not force_disabled:
            raise DispatchError(
                f"job '{job_id}' is disabled — pass force_disabled=true to run it anyway"
            )
        to_run.append((job, now, True))
    else:
        for job in jobs:
            if not job.enabled:
                continue
            since = ledger.get_cursor(job.id, now)
            occurrences = scheduler.compute_due_occurrences(job.schedule, job.timezone, since, now)
            if not occurrences:
                continue
            evaluated_job_ids.add(job.id)
            run_list, skip_list = scheduler.apply_misfire_policy(
                occurrences, job.misfire_policy, job.misfire_cap
            )
            for occ in skip_list:
                history.append_skipped(
                    job.id, iso(occ), "skipped by misfire policy (a more recent occurrence ran instead)"
                )
                skipped_count += 1
            for occ in run_list:
                if ledger.is_claimed(job.id, occ):
                    continue
                to_run.append((job, occ, False))

    for job, occ, _manual in to_run:
        ledger.claim(job.id, occ, now)

    prior_failures = {job.id: ledger.consecutive_failures(job.id) for job, _occ, _m in to_run}

    return PlannedRun(
        now=now,
        to_run=to_run,
        evaluated_job_ids=evaluated_job_ids,
        prior_failures=prior_failures,
        skipped_count=skipped_count,
        stale_claims_reconciled=stale,
    )


def execute(
    planned: PlannedRun,
    ledger: Ledger,
    history: HistoryStore,
    notifier: Notifier,
    repo_root: Path,
    max_concurrency: int = 5,
    run_url: Optional[str] = None,
) -> DispatchSummary:
    """Run everything plan() claimed, record results, notify, advance cursors.

    `run_url` (if given) is attributed to every result from this tick — it's
    display metadata for the dashboard, not something that affects dedup,
    scheduling, or retries.
    """
    results = run_bounded(
        [(lambda j=job, o=occ: run_with_retry(j, o, repo_root)) for job, occ, _m in planned.to_run],
        max_workers=max_concurrency,
    )

    for (job, occ, manual), result in zip(planned.to_run, results):
        result.trigger = "manual" if manual else "scheduled"
        result.run_url = run_url
        ledger.finalize(job.id, occ, result.status, planned.now)
        history.append(job.id, result, job.history_limit)

        if not manual:
            ledger.advance_cursor(job.id, planned.now, result.status)

        was_failing = planned.prior_failures.get(job.id, 0) > 0
        if result.status == "failed" and job.notify_on_failure:
            notifier.notify_failure(job, result, ledger.consecutive_failures(job.id))
        elif result.status == "success" and was_failing and job.notify_on_recovery:
            notifier.notify_recovery(job, result)

    # Jobs evaluated this tick but left with nothing to run (e.g. everything
    # was already claimed) still need their watermark to move forward.
    ran_job_ids = {job.id for job, _occ, manual in planned.to_run if not manual}
    for jid in planned.evaluated_job_ids - ran_job_ids:
        last_status = ledger.cursors.get(jid, {}).get("last_status", "success")
        ledger.advance_cursor(jid, planned.now, last_status)

    ledger.prune_dedup(planned.now)
    ledger.record_heartbeat(
        planned.now, "ok", detail=f"{len(planned.to_run)} executed, {planned.skipped_count} skipped"
    )

    return DispatchSummary(
        now=planned.now,
        ran=results,
        skipped_count=planned.skipped_count,
        stale_claims_reconciled=planned.stale_claims_reconciled,
    )
