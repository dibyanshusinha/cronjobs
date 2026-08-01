"use strict";

const { parseIso } = require("../../engine/timeutil");

const API_ROOT = "https://api.github.com";
const FAILURE_LABEL = "cron-failure";

class GitHubIssuesNotifier {
  constructor(ledger, repo, token) {
    this.ledger = ledger;
    this.repo = repo;
    this.token = token;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  async notifyFailure(job, result, consecutiveFailures) {
    const body =
      `Job \`${job.id}\` failed.\n\n` +
      `- Scheduled: ${result.scheduled_time}\n` +
      `- Attempts: ${result.attempts}\n` +
      `- Detail: ${result.detail}\n` +
      `- Consecutive failures: ${consecutiveFailures}\n\n` +
      "See the Actions run and dashboard for more.";
    try {
      const existing = this.ledger.openIssueNumber(job.id);
      if (existing) {
        await this.comment(existing, body);
      } else {
        const number = await this.createIssue(job, body);
        if (number !== null) this.ledger.recordOpenIssue(job.id, number, parseIso(result.finished_at));
      }
    } catch (err) {
      // Best-effort notification: never fail the dispatcher after job execution.
    }
  }

  async notifyRecovery(job, result) {
    const existing = this.ledger.openIssueNumber(job.id);
    if (!existing) return;
    try {
      await this.comment(existing, `Recovered: job \`${job.id}\` succeeded at ${result.finished_at}.`);
      await this.close(existing);
      this.ledger.clearIssue(job.id);
    } catch (err) {
      // Best-effort notification.
    }
  }

  async createIssue(job, body) {
    const response = await fetch(`${API_ROOT}/repos/${this.repo}/issues`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        title: `[cron] ${job.id} failing`,
        body,
        labels: [FAILURE_LABEL, `job:${job.id}`],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status >= 300) return null;
    const data = await response.json();
    return data.number ?? null;
  }

  async comment(issueNumber, body) {
    await fetch(`${API_ROOT}/repos/${this.repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(15000),
    });
  }

  async close(issueNumber) {
    await fetch(`${API_ROOT}/repos/${this.repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      signal: AbortSignal.timeout(15000),
    });
  }
}

module.exports = { GitHubIssuesNotifier };
