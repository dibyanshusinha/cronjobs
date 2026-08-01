"""Cursor tracking, claim/finalize dedup, failure-issue tracking, and heartbeat.

All business logic lives here, backend-agnostic — it only ever calls
`StateBackend.load`/`save`. This is what makes it possible to point the exact
same logic at local JSON files (GitHub Actions edition) or, later, at SQLite
(self-hosted edition) with zero changes to this file.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from .state_backend import StateBackend
from .timeutil import iso, parse_iso

DEFAULT_LOOKBACK = timedelta(minutes=15)
DEDUP_RETENTION = timedelta(days=7)
STALE_CLAIM_GRACE = timedelta(minutes=10)


class Ledger:
    def __init__(self, backend: StateBackend):
        self.backend = backend
        self.cursors: dict = {}
        self.dedup: dict = {}
        self.issues: dict = {}
        self.heartbeat: dict = {}
        self._dirty: set[str] = set()

    def load(self) -> None:
        self.cursors = self.backend.load("state/cursors", {})
        self.dedup = self.backend.load("state/dedup", {"executed": {}})
        self.issues = self.backend.load("state/issues", {})
        self.heartbeat = self.backend.load("state/heartbeat", {})
        self._dirty.clear()

    # ---- cursors ----

    def get_cursor(self, job_id: str, now: datetime, lookback: timedelta = DEFAULT_LOOKBACK) -> datetime:
        """Persisted watermark if we've evaluated this job before; otherwise a
        short rolling lookback (never backfills from job-creation time)."""
        entry = self.cursors.get(job_id)
        if entry is None:
            return now - lookback
        return parse_iso(entry["last_evaluated_utc"])

    def advance_cursor(self, job_id: str, when: datetime, status: str) -> None:
        prev = self.cursors.get(job_id, {})
        consecutive_failures = prev.get("consecutive_failures", 0)
        if status == "failed":
            consecutive_failures += 1
        elif status == "success":
            consecutive_failures = 0
        self.cursors[job_id] = {
            "last_evaluated_utc": iso(when),
            "last_status": status,
            "consecutive_failures": consecutive_failures,
        }
        self._dirty.add("state/cursors")

    def consecutive_failures(self, job_id: str) -> int:
        """Failures in a row as of the *last* advance_cursor call — call this
        BEFORE advancing the cursor with a new result if you need to detect a
        transition into/out of a failing streak (e.g. for recovery notifications)."""
        return self.cursors.get(job_id, {}).get("consecutive_failures", 0)

    # ---- dedup / claim-finalize ----

    @staticmethod
    def _key(job_id: str, scheduled_time: datetime) -> str:
        return f"{job_id}|{iso(scheduled_time)}"

    def is_claimed(self, job_id: str, scheduled_time: datetime) -> bool:
        """True if this occurrence has ever been claimed, regardless of outcome.
        We never re-execute a claimed occurrence — we can't know whether an
        interrupted run's side effect actually fired, so "maybe already ran" is
        treated the same as "definitely already ran". `reconcile_stale_claims`
        is what cleans up abandoned "running" entries, not re-execution."""
        return self._key(job_id, scheduled_time) in self.dedup["executed"]

    def claim(self, job_id: str, scheduled_time: datetime, now: datetime) -> None:
        self.dedup["executed"][self._key(job_id, scheduled_time)] = {
            "status": "running",
            "claimed_at": iso(now),
            "finished_at": None,
        }
        self._dirty.add("state/dedup")

    def reconcile_stale_claims(self, now: datetime, grace: timedelta = STALE_CLAIM_GRACE) -> list[str]:
        """Flip claims stuck in 'running' past `grace` (dispatcher was killed
        mid-execution) to 'failed' so they stop looking perpetually in-flight.
        Returns the affected dedup keys for logging/heartbeat visibility."""
        affected = []
        for key, entry in self.dedup["executed"].items():
            if entry["status"] == "running":
                claimed_at = parse_iso(entry["claimed_at"])
                if (now - claimed_at) >= grace:
                    entry["status"] = "failed"
                    entry["finished_at"] = iso(now)
                    affected.append(key)
        if affected:
            self._dirty.add("state/dedup")
        return affected

    def finalize(self, job_id: str, scheduled_time: datetime, status: str, finished_at: datetime) -> None:
        key = self._key(job_id, scheduled_time)
        entry = self.dedup["executed"].setdefault(
            key, {"status": "running", "claimed_at": iso(finished_at)}
        )
        entry["status"] = status
        entry["finished_at"] = iso(finished_at)
        self._dirty.add("state/dedup")

    def prune_dedup(self, now: datetime) -> None:
        cutoff = now - DEDUP_RETENTION
        executed = self.dedup["executed"]
        kept = {}
        for key, entry in executed.items():
            ts_str = entry.get("finished_at") or entry.get("claimed_at")
            ts = parse_iso(ts_str) if ts_str else now
            if ts >= cutoff:
                kept[key] = entry
        if len(kept) != len(executed):
            self._dirty.add("state/dedup")
        self.dedup["executed"] = kept

    # ---- failure issue tracking ----

    def open_issue_number(self, job_id: str) -> Optional[int]:
        return self.issues.get(job_id, {}).get("issue_number")

    def record_open_issue(self, job_id: str, issue_number: int, opened_at: datetime) -> None:
        self.issues[job_id] = {"issue_number": issue_number, "opened_at": iso(opened_at)}
        self._dirty.add("state/issues")

    def clear_issue(self, job_id: str) -> None:
        if job_id in self.issues:
            del self.issues[job_id]
            self._dirty.add("state/issues")

    # ---- heartbeat ----

    def record_heartbeat(self, now: datetime, status: str, detail: str = "") -> None:
        self.heartbeat = {"last_run_utc": iso(now), "status": status, "detail": detail[:200]}
        self._dirty.add("state/heartbeat")

    # ---- persistence ----

    def dirty_names(self) -> set[str]:
        return set(self._dirty)

    def flush(self, only: Optional[set[str]] = None) -> list[str]:
        """Persist dirty blobs (optionally restricted to `only`), returning the
        names actually written so the caller (a git-committing adapter) knows
        what changed."""
        names = self._dirty if only is None else (self._dirty & only)
        written = []
        for name in sorted(names):
            data = {
                "state/cursors": self.cursors,
                "state/dedup": self.dedup,
                "state/issues": self.issues,
                "state/heartbeat": self.heartbeat,
            }[name]
            self.backend.save(name, data)
            written.append(name)
        self._dirty -= names
        return written
