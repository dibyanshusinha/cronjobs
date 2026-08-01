"""Pure cron math: given a job's schedule/timezone and a time window, figure out
which occurrences are due. No I/O, no state — fully unit-testable with fixed clocks.
"""
from __future__ import annotations

from datetime import datetime
from datetime import timezone as dt_timezone
from zoneinfo import ZoneInfo

from croniter import croniter

# Defensive cap on occurrences computed in a single window. Normal operation never
# gets close to this; it exists to fail loudly if a cursor is somehow badly stale
# rather than silently burning CPU/time on a runaway loop.
MAX_OCCURRENCES_PER_CALL = 2000


def compute_due_occurrences(
    schedule: str, tz_name: str, since: datetime, now: datetime
) -> list[datetime]:
    """Every cron occurrence in (since, now], evaluated against `schedule` in the
    job's timezone. `since` and `now` must be tz-aware; returned datetimes are UTC,
    oldest first.
    """
    if since.tzinfo is None or now.tzinfo is None:
        raise ValueError("since/now must be timezone-aware")

    tz = ZoneInfo(tz_name)
    since_local = since.astimezone(tz)
    now_local = now.astimezone(tz)

    it = croniter(schedule, since_local)
    occurrences: list[datetime] = []
    for _ in range(MAX_OCCURRENCES_PER_CALL):
        nxt = it.get_next(datetime)
        if nxt > now_local:
            break
        occurrences.append(nxt.astimezone(dt_timezone.utc))
    else:
        raise RuntimeError(
            f"schedule '{schedule}' produced more than {MAX_OCCURRENCES_PER_CALL} "
            "occurrences in one window — refusing to continue (cursor likely stale)"
        )
    return occurrences


def apply_misfire_policy(
    occurrences: list[datetime], policy: str, cap: int
) -> tuple[list[datetime], list[datetime]]:
    """Split occurrences (oldest first) into (to_run, skipped) per misfire policy.

    most_recent: only the single latest occurrence runs; older missed ones are
    recorded as skipped rather than silently dropped.
    all: every occurrence runs, bounded by `cap` (keeps the most recent `cap`,
    skips the rest) as a safety valve against a huge backlog.
    """
    if not occurrences:
        return [], []
    if policy == "most_recent":
        return [occurrences[-1]], occurrences[:-1]
    if policy == "all":
        if len(occurrences) <= cap:
            return list(occurrences), []
        return occurrences[-cap:], occurrences[:-cap]
    raise ValueError(f"unknown misfire policy '{policy}'")


def next_due_after(schedule: str, tz_name: str, after: datetime) -> datetime:
    """Next occurrence strictly after `after`, in UTC — used for dashboard display."""
    tz = ZoneInfo(tz_name)
    after_local = after.astimezone(tz)
    it = croniter(schedule, after_local)
    nxt = it.get_next(datetime)
    return nxt.astimezone(dt_timezone.utc)
