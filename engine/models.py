from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

DEFAULT_TIMEZONE = "UTC"
DEFAULT_RETRIES = 0
DEFAULT_RETRY_BACKOFF_SECONDS = 30
DEFAULT_TIMEOUT_SECONDS = 30
DEFAULT_MISFIRE_POLICY = "most_recent"
DEFAULT_MISFIRE_CAP = 10
DEFAULT_HISTORY_LIMIT = 50


@dataclass
class HttpSpec:
    url: str
    method: str = "GET"
    headers: dict = field(default_factory=dict)
    body: str = ""
    expected_status: list = field(default_factory=lambda: list(range(200, 300)))
    validate_contains: Optional[str] = None
    timeout_seconds: int = 30


@dataclass
class ScriptSpec:
    path: str
    args: list = field(default_factory=list)
    interpreter: Optional[str] = None
    timeout_seconds: int = 60


@dataclass
class Job:
    id: str
    schedule: str
    type: str
    file_path: str
    name: str = ""
    description: str = ""
    timezone: str = DEFAULT_TIMEZONE
    enabled: bool = True
    retries: int = DEFAULT_RETRIES
    retry_backoff_seconds: int = DEFAULT_RETRY_BACKOFF_SECONDS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    misfire_policy: str = DEFAULT_MISFIRE_POLICY
    misfire_cap: int = DEFAULT_MISFIRE_CAP
    history_limit: int = DEFAULT_HISTORY_LIMIT
    notify_on_failure: bool = True
    notify_on_recovery: bool = True
    http: Optional[HttpSpec] = None
    script: Optional[ScriptSpec] = None


@dataclass
class Occurrence:
    job_id: str
    scheduled_time: str  # ISO 8601 UTC, e.g. 2026-08-02T03:15:00+00:00
    manual: bool = False


@dataclass
class RunResult:
    job_id: str
    scheduled_time: str
    status: str  # success | failed | skipped
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    duration_ms: Optional[int] = None
    attempts: int = 0
    detail: str = ""
    trigger: str = "scheduled"  # "scheduled" | "manual" — set by dispatch.execute()
    run_url: Optional[str] = None  # GitHub Actions run link, set by the GitHub adapter
