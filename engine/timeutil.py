"""Shared ISO-8601 UTC helpers. Kept separate from ledger.py so lower-level
modules (executors) don't have to import the ledger's business logic just to
format a timestamp.
"""
from __future__ import annotations

from datetime import datetime
from datetime import timezone as dt_timezone


def iso(dt: datetime) -> str:
    return dt.astimezone(dt_timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
