from datetime import datetime, timezone

import pytest

from engine import scheduler


def dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def test_compute_due_occurrences_basic_window():
    occurrences = scheduler.compute_due_occurrences(
        "*/15 * * * *", "UTC", dt("2026-01-01T00:00:00"), dt("2026-01-01T00:31:00")
    )
    assert [o.isoformat() for o in occurrences] == [
        "2026-01-01T00:15:00+00:00",
        "2026-01-01T00:30:00+00:00",
    ]


def test_compute_due_occurrences_empty_window_yields_nothing():
    occurrences = scheduler.compute_due_occurrences(
        "0 3 * * *", "UTC", dt("2026-01-01T00:00:00"), dt("2026-01-01T00:05:00")
    )
    assert occurrences == []


def test_compute_due_occurrences_since_is_exclusive():
    # exactly on the boundary should not be re-included
    occurrences = scheduler.compute_due_occurrences(
        "*/15 * * * *", "UTC", dt("2026-01-01T00:15:00"), dt("2026-01-01T00:15:00")
    )
    assert occurrences == []


def test_compute_due_occurrences_timezone_aware():
    # 09:00 IST == 03:30 UTC
    occurrences = scheduler.compute_due_occurrences(
        "0 9 * * *", "Asia/Kolkata", dt("2026-01-01T00:00:00"), dt("2026-01-01T06:00:00")
    )
    assert len(occurrences) == 1
    assert occurrences[0].isoformat() == "2026-01-01T03:30:00+00:00"


def test_compute_due_occurrences_requires_tz_aware():
    with pytest.raises(ValueError):
        scheduler.compute_due_occurrences(
            "* * * * *", "UTC", datetime(2026, 1, 1), dt("2026-01-01T00:05:00")
        )


def test_misfire_policy_most_recent_keeps_only_latest():
    occs = [dt("2026-01-01T00:00:00"), dt("2026-01-01T00:15:00"), dt("2026-01-01T00:30:00")]
    to_run, skipped = scheduler.apply_misfire_policy(occs, "most_recent", cap=10)
    assert to_run == [occs[-1]]
    assert skipped == occs[:-1]


def test_misfire_policy_all_under_cap_keeps_everything():
    occs = [dt("2026-01-01T00:00:00"), dt("2026-01-01T00:15:00")]
    to_run, skipped = scheduler.apply_misfire_policy(occs, "all", cap=10)
    assert to_run == occs
    assert skipped == []


def test_misfire_policy_all_over_cap_trims_oldest():
    occs = [dt(f"2026-01-01T00:{m:02d}:00") for m in range(0, 60, 5)]  # 12 occurrences
    to_run, skipped = scheduler.apply_misfire_policy(occs, "all", cap=5)
    assert to_run == occs[-5:]
    assert skipped == occs[:-5]


def test_misfire_policy_empty_input():
    assert scheduler.apply_misfire_policy([], "most_recent", cap=10) == ([], [])


def test_misfire_policy_unknown_raises():
    with pytest.raises(ValueError):
        scheduler.apply_misfire_policy([dt("2026-01-01T00:00:00")], "bogus", cap=10)


def test_next_due_after():
    nxt = scheduler.next_due_after("0 3 * * *", "UTC", dt("2026-01-01T00:00:00"))
    assert nxt.isoformat() == "2026-01-01T03:00:00+00:00"
