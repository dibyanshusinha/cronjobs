"""GitHub Issues adapter implementing engine.notify.Notifier. One open issue
per failing job (comments accumulate on it, never spammed with new issues),
auto-closed with a recovery comment on the next success. Issue-number
tracking lives in the shared Ledger (state/issues.json) so it survives across
runs regardless of which notifier backend is in use.

Best-effort: a notification failure (network blip, rate limit) never fails
the dispatcher run — job execution and state persistence already happened by
the time this is called.
"""
from __future__ import annotations

import requests

from engine.ledger import Ledger
from engine.models import Job, RunResult
from engine.timeutil import parse_iso

API_ROOT = "https://api.github.com"
FAILURE_LABEL = "cron-failure"


class GitHubIssuesNotifier:
    def __init__(self, ledger: Ledger, repo: str, token: str):
        self.ledger = ledger
        self.repo = repo
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            }
        )

    def notify_failure(self, job: Job, result: RunResult, consecutive_failures: int) -> None:
        body = (
            f"Job `{job.id}` failed.\n\n"
            f"- Scheduled: {result.scheduled_time}\n"
            f"- Attempts: {result.attempts}\n"
            f"- Detail: {result.detail}\n"
            f"- Consecutive failures: {consecutive_failures}\n\n"
            f"See the Actions run and dashboard for more."
        )
        try:
            existing = self.ledger.open_issue_number(job.id)
            if existing:
                self._comment(existing, body)
            else:
                number = self._create_issue(job, body)
                if number is not None:
                    self.ledger.record_open_issue(job.id, number, parse_iso(result.finished_at))
        except requests.exceptions.RequestException:
            pass

    def notify_recovery(self, job: Job, result: RunResult) -> None:
        existing = self.ledger.open_issue_number(job.id)
        if not existing:
            return
        try:
            self._comment(existing, f"Recovered: job `{job.id}` succeeded at {result.finished_at}.")
            self._close(existing)
            self.ledger.clear_issue(job.id)
        except requests.exceptions.RequestException:
            pass

    def _create_issue(self, job: Job, body: str) -> int | None:
        resp = self.session.post(
            f"{API_ROOT}/repos/{self.repo}/issues",
            json={
                "title": f"[cron] {job.id} failing",
                "body": body,
                "labels": [FAILURE_LABEL, f"job:{job.id}"],
            },
            timeout=15,
        )
        if resp.status_code >= 300:
            return None
        return resp.json().get("number")

    def _comment(self, issue_number: int, body: str) -> None:
        self.session.post(
            f"{API_ROOT}/repos/{self.repo}/issues/{issue_number}/comments",
            json={"body": body},
            timeout=15,
        )

    def _close(self, issue_number: int) -> None:
        self.session.patch(
            f"{API_ROOT}/repos/{self.repo}/issues/{issue_number}",
            json={"state": "closed", "state_reason": "completed"},
            timeout=15,
        )
