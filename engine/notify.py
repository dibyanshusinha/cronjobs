"""Notification port. The core never talks to GitHub Issues, Slack, email, etc.
directly — it calls through this Protocol, and an adapter (e.g.
adapters/github/issues_notifier.py) supplies the real implementation.
"""
from __future__ import annotations

from typing import Protocol

from .models import Job, RunResult


class Notifier(Protocol):
    def notify_failure(self, job: Job, result: RunResult, consecutive_failures: int) -> None: ...

    def notify_recovery(self, job: Job, result: RunResult) -> None: ...


class NoopNotifier:
    """Used by tests and local dry runs — does nothing."""

    def notify_failure(self, job: Job, result: RunResult, consecutive_failures: int) -> None:
        pass

    def notify_recovery(self, job: Job, result: RunResult) -> None:
        pass
