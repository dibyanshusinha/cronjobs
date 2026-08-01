from __future__ import annotations

import json
from pathlib import Path

import jsonschema

from .models import (
    DEFAULT_HISTORY_LIMIT,
    DEFAULT_MISFIRE_CAP,
    DEFAULT_MISFIRE_POLICY,
    DEFAULT_RETRIES,
    DEFAULT_RETRY_BACKOFF_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_TIMEZONE,
    HttpSpec,
    Job,
    ScriptSpec,
)

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "job.schema.json"
_schema_cache: dict | None = None


class ValidationError(Exception):
    """Raised for schema violations or duplicate job ids. May bundle multiple messages."""


def _load_schema() -> dict:
    global _schema_cache
    if _schema_cache is None:
        with open(SCHEMA_PATH) as f:
            _schema_cache = json.load(f)
    return _schema_cache


def validate_merged(merged: dict, file_path: Path) -> None:
    validator = jsonschema.Draft7Validator(_load_schema())
    errors = sorted(validator.iter_errors(merged), key=lambda e: list(e.path))
    if errors:
        messages = [
            f"{file_path}: {e.message} (at {'/'.join(str(p) for p in e.path) or '<root>'})"
            for e in errors
        ]
        raise ValidationError("\n".join(messages))


def build_job(merged: dict, file_path: Path) -> Job:
    notify = merged.get("notify", {})
    top_timeout = merged.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)

    http_spec = None
    script_spec = None
    if merged["type"] == "http":
        h = merged["http"]
        http_spec = HttpSpec(
            url=h["url"],
            method=h.get("method", "GET"),
            headers=h.get("headers", {}),
            body=h.get("body", ""),
            expected_status=h.get("expected_status", list(range(200, 300))),
            validate_contains=h.get("validate_contains"),
            timeout_seconds=h.get("timeout_seconds", top_timeout),
        )
    else:
        s = merged["script"]
        script_spec = ScriptSpec(
            path=s["path"],
            args=s.get("args", []),
            interpreter=s.get("interpreter"),
            timeout_seconds=s.get("timeout_seconds", top_timeout),
        )

    return Job(
        id=merged["id"],
        schedule=merged["schedule"],
        type=merged["type"],
        file_path=str(file_path),
        name=merged.get("name", merged["id"]),
        description=merged.get("description", ""),
        timezone=merged.get("timezone", DEFAULT_TIMEZONE),
        enabled=merged.get("enabled", True),
        retries=merged.get("retries", DEFAULT_RETRIES),
        retry_backoff_seconds=merged.get("retry_backoff_seconds", DEFAULT_RETRY_BACKOFF_SECONDS),
        timeout_seconds=top_timeout,
        misfire_policy=merged.get("misfire_policy", DEFAULT_MISFIRE_POLICY),
        misfire_cap=merged.get("misfire_cap", DEFAULT_MISFIRE_CAP),
        history_limit=merged.get("history_limit", DEFAULT_HISTORY_LIMIT),
        notify_on_failure=notify.get("on_failure", True),
        notify_on_recovery=notify.get("on_recovery", True),
        http=http_spec,
        script=script_spec,
    )


def check_duplicate_ids(jobs: list[Job]) -> None:
    seen: dict[str, str] = {}
    dupes: list[str] = []
    for job in jobs:
        if job.id in seen:
            dupes.append(f"duplicate job id '{job.id}': {seen[job.id]} and {job.file_path}")
        else:
            seen[job.id] = job.file_path
    if dupes:
        raise ValidationError("\n".join(dupes))
