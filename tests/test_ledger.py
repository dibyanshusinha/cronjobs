from datetime import datetime, timedelta, timezone
from pathlib import Path

from engine.ledger import Ledger
from engine.state_backend import JsonFileStateBackend


def dt(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def make_ledger(tmp_path: Path) -> Ledger:
    ledger = Ledger(JsonFileStateBackend(tmp_path))
    ledger.load()
    return ledger


def test_get_cursor_defaults_to_rolling_lookback_for_new_job(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    now = dt("2026-01-01T12:00:00")
    cursor = ledger.get_cursor("new-job", now, lookback=timedelta(minutes=15))
    assert cursor == now - timedelta(minutes=15)


def test_advance_cursor_persists_and_is_read_back(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    now = dt("2026-01-01T12:00:00")
    ledger.advance_cursor("job-a", now, "success")
    assert "state/cursors" in ledger.dirty_names()
    ledger.flush()

    ledger2 = make_ledger(tmp_path)
    assert ledger2.get_cursor("job-a", now + timedelta(hours=1)) == now


def test_consecutive_failures_tracks_streak(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    now = dt("2026-01-01T12:00:00")
    ledger.advance_cursor("job-a", now, "failed")
    ledger.advance_cursor("job-a", now, "failed")
    assert ledger.consecutive_failures("job-a") == 2
    ledger.advance_cursor("job-a", now, "success")
    assert ledger.consecutive_failures("job-a") == 0


def test_claim_then_is_claimed(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    now = dt("2026-01-01T12:00:00")
    occ = dt("2026-01-01T12:15:00")
    assert ledger.is_claimed("job-a", occ) is False
    ledger.claim("job-a", occ, now)
    assert ledger.is_claimed("job-a", occ) is True


def test_finalize_keeps_claimed_true(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    now = dt("2026-01-01T12:00:00")
    occ = dt("2026-01-01T12:15:00")
    ledger.claim("job-a", occ, now)
    ledger.finalize("job-a", occ, "success", now)
    assert ledger.is_claimed("job-a", occ) is True
    assert ledger.dedup["executed"][f"job-a|{occ.isoformat().replace('+00:00', 'Z')}"]["status"] == "success"


def test_reconcile_stale_claims_flips_old_running_to_failed(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    claimed_at = dt("2026-01-01T12:00:00")
    occ = dt("2026-01-01T12:15:00")
    ledger.claim("job-a", occ, claimed_at)

    still_fresh = claimed_at + timedelta(minutes=1)
    affected = ledger.reconcile_stale_claims(still_fresh, grace=timedelta(minutes=10))
    assert affected == []

    much_later = claimed_at + timedelta(minutes=11)
    affected = ledger.reconcile_stale_claims(much_later, grace=timedelta(minutes=10))
    assert len(affected) == 1
    key = ledger._key("job-a", occ)
    assert ledger.dedup["executed"][key]["status"] == "failed"


def test_prune_dedup_removes_old_entries(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    old_time = dt("2026-01-01T00:00:00")
    ledger.claim("job-a", old_time, old_time)
    ledger.finalize("job-a", old_time, "success", old_time)

    now = old_time + timedelta(days=30)
    ledger.prune_dedup(now)
    assert ledger.dedup["executed"] == {}


def test_prune_dedup_keeps_recent_entries(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    recent = dt("2026-01-01T00:00:00")
    ledger.claim("job-a", recent, recent)
    ledger.finalize("job-a", recent, "success", recent)

    now = recent + timedelta(hours=1)
    ledger.prune_dedup(now)
    assert len(ledger.dedup["executed"]) == 1


def test_issue_tracking_round_trip(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    now = dt("2026-01-01T12:00:00")
    assert ledger.open_issue_number("job-a") is None
    ledger.record_open_issue("job-a", 42, now)
    assert ledger.open_issue_number("job-a") == 42
    ledger.clear_issue("job-a")
    assert ledger.open_issue_number("job-a") is None


def test_heartbeat_always_marks_dirty(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    now = dt("2026-01-01T12:00:00")
    ledger.record_heartbeat(now, "ok", detail="0 executed")
    assert "state/heartbeat" in ledger.dirty_names()
    assert ledger.heartbeat["status"] == "ok"


def test_flush_only_writes_requested_names(tmp_path: Path):
    ledger = make_ledger(tmp_path)
    now = dt("2026-01-01T12:00:00")
    ledger.claim("job-a", now, now)
    ledger.record_heartbeat(now, "ok")
    written = ledger.flush(only={"state/dedup"})
    assert written == ["state/dedup"]
    assert "state/heartbeat" in ledger.dirty_names()  # not flushed yet
