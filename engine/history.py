"""Per-job run history, capped and redacted before it ever touches storage.

This is where the "never store response bodies/headers/credentials/raw script
output" rule is enforced structurally: RunResult.detail is the only free-text
field, executors are responsible for keeping it to a safe summary (status code,
exit code, timing — never payloads), and this module hard-caps it again as a
backstop regardless of what an executor produced.
"""
from __future__ import annotations

from dataclasses import asdict

from .models import RunResult
from .state_backend import StateBackend

MAX_DETAIL_CHARS = 300


def _sanitize(result: RunResult) -> dict:
    entry = asdict(result)
    entry["detail"] = (entry.get("detail") or "")[:MAX_DETAIL_CHARS]
    return entry


class HistoryStore:
    def __init__(self, backend: StateBackend):
        self.backend = backend

    def _name(self, job_id: str) -> str:
        return f"history/{job_id}"

    def append(self, job_id: str, result: RunResult, limit: int) -> None:
        data = self.backend.load(self._name(job_id), {"runs": []})
        data["runs"].append(_sanitize(result))
        data["runs"] = data["runs"][-limit:]
        self.backend.save(self._name(job_id), data)

    def append_skipped(self, job_id: str, scheduled_time_iso: str, reason: str) -> None:
        data = self.backend.load(self._name(job_id), {"runs": []})
        data["runs"].append(
            {
                "job_id": job_id,
                "scheduled_time": scheduled_time_iso,
                "status": "skipped",
                "started_at": None,
                "finished_at": None,
                "duration_ms": None,
                "attempts": 0,
                "detail": reason[:MAX_DETAIL_CHARS],
            }
        )
        # Skipped entries don't have a job's history_limit handy here; callers
        # that care about a tight cap should follow up with append()'s trimming
        # on the next real run. A generous cap still prevents unbounded growth.
        data["runs"] = data["runs"][-200:]
        self.backend.save(self._name(job_id), data)

    def recent(self, job_id: str, limit: int = 10) -> list[dict]:
        data = self.backend.load(self._name(job_id), {"runs": []})
        return data["runs"][-limit:]
