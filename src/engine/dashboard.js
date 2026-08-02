"use strict";

const scheduler = require("./scheduler");
const { iso } = require("./timeutil");

function buildSummary(jobs, ledger, history, now) {
  let failing = 0;
  const jobEntries = [...jobs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((job) => {
      const cursor = ledger.cursors[job.id] || {};
      const consecutiveFailures = cursor.consecutive_failures || 0;
      if (consecutiveFailures > 0) failing += 1;

      let nextDue = null;
      try {
        nextDue = iso(scheduler.nextDueAfter(job.schedule, job.timezone, now));
      } catch (err) {
        nextDue = null;
      }

      const recent = history.recent(job.id, Math.min(job.history_limit || 50, 50));
      const lastReal = [...recent].reverse().find((run) => run.status !== "skipped") || null;
      const lastRunAt = cursor.last_run_utc || (lastReal ? lastReal.finished_at : cursor.last_evaluated_utc);
      const lastStatus = cursor.last_status || (lastReal ? lastReal.status : null);
      const lastTrigger = cursor.last_trigger || (lastReal ? lastReal.trigger : null);

      return {
        id: job.id,
        name: job.name,
        type: job.type,
        enabled: job.enabled,
        auto_disabled: Boolean(cursor.auto_disabled),
        auto_disabled_reason: cursor.auto_disabled_reason || null,
        failure_pause_until_utc: cursor.failure_pause_until_utc || null,
        schedule: job.schedule,
        timezone: job.timezone,
        history_retention_days: job.history_retention_days,
        failure_policy: job.failure_policy,
        last_evaluated_utc: lastRunAt,
        last_status: lastStatus,
        last_trigger: lastTrigger,
        consecutive_failures: consecutiveFailures,
        next_due_utc: nextDue,
        open_issue: ledger.openIssueNumber(job.id),
        recent_history: recent,
      };
    });

  return {
    generated_at: iso(now),
    heartbeat: ledger.heartbeat,
    jobs: jobEntries,
    meta: { total_jobs: jobs.length, failing_jobs: failing },
  };
}

module.exports = { buildSummary };
