"use strict";

const scheduler = require("./scheduler");
const { runBounded } = require("./concurrency");
const { runWithRetry } = require("./executors/base");
const { iso } = require("./timeutil");

class DispatchError extends Error {}

function plan(jobs, ledger, history, now, options = {}) {
  const { jobId = null, forceDisabled = false } = options;
  const stale = ledger.reconcileStaleClaims(now);
  const toRun = [];
  const evaluatedJobIds = new Set();
  let skippedCount = 0;

  if (jobId) {
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new DispatchError(`unknown job id '${jobId}'`);
    if ((!job.enabled || ledger.isAutoDisabled(job.id)) && !forceDisabled) {
      throw new DispatchError(`job '${jobId}' is disabled - pass force_disabled=true to run it anyway`);
    }
    toRun.push({ job, occurrence: now, manual: true });
  } else {
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (ledger.isAutoDisabled(job.id)) continue;
      const pauseUntil = ledger.failurePauseUntil(job.id);
      if (pauseUntil && pauseUntil > now) continue;
      const since = ledger.getCursor(job.id, now);
      const occurrences = scheduler.computeDueOccurrences(job.schedule, job.timezone, since, now);
      if (!occurrences.length) continue;
      evaluatedJobIds.add(job.id);
      const [runList, skipList] = scheduler.applyMisfirePolicy(
        occurrences,
        job.misfire_policy,
        job.misfire_cap
      );
      for (const occurrence of skipList) {
        history.appendSkipped(
          job.id,
          iso(occurrence),
          "skipped by misfire policy (a more recent occurrence ran instead)"
        );
        skippedCount += 1;
      }
      for (const occurrence of runList) {
        if (!ledger.isClaimed(job.id, occurrence)) {
          toRun.push({ job, occurrence, manual: false });
        }
      }
    }
  }

  for (const item of toRun) ledger.claim(item.job.id, item.occurrence, now);
  const priorFailures = {};
  for (const item of toRun) priorFailures[item.job.id] = ledger.consecutiveFailures(item.job.id);

  return {
    now,
    to_run: toRun,
    evaluated_job_ids: evaluatedJobIds,
    prior_failures: priorFailures,
    skipped_count: skippedCount,
    stale_claims_reconciled: stale,
  };
}

function failurePolicyPatch(job, planned, result) {
  if (result.status === "success") return {};
  const policy = job.failure_policy || {};
  const prior = planned.prior_failures[job.id] || 0;
  const failures = prior + 1;
  const initial = policy.initial_backoff_seconds ?? 300;
  const multiplier = policy.backoff_multiplier ?? 2;
  const max = policy.max_backoff_seconds ?? 21600;
  const autoDisableAfter = policy.auto_disable_after_consecutive_failures ?? 5;
  const backoffSeconds = Math.min(max, Math.round(initial * multiplier ** Math.max(0, failures - 1)));
  const patch = {
    consecutive_failures: failures,
    failure_pause_until_utc:
      backoffSeconds > 0 ? new Date(planned.now.getTime() + backoffSeconds * 1000).toISOString() : null,
    auto_disabled: false,
    auto_disabled_at_utc: null,
    auto_disabled_reason: null,
  };
  if (failures >= autoDisableAfter) {
    patch.auto_disabled = true;
    patch.auto_disabled_at_utc = planned.now.toISOString();
    patch.auto_disabled_reason = `${failures} consecutive failures`;
  }
  return patch;
}

async function execute(planned, ledger, history, notifier, repoRoot, options = {}) {
  const { maxConcurrency = 5, runUrl = null } = options;
  const tasks = planned.to_run.map(
    ({ job, occurrence }) => async () => runWithRetry(job, occurrence, repoRoot)
  );
  const results = await runBounded(tasks, maxConcurrency);

  for (let i = 0; i < planned.to_run.length; i += 1) {
    const { job, occurrence, manual } = planned.to_run[i];
    const result = results[i];
    result.trigger = manual ? "manual" : "scheduled";
    result.run_url = runUrl;
    ledger.finalize(job.id, occurrence, result.status, planned.now);
    history.append(job.id, result, job.history_limit);

    const safetyPatch = {
      ...failurePolicyPatch(job, planned, result),
      last_run_utc: result.finished_at,
      last_trigger: manual ? "manual" : "scheduled",
    };
    if (!manual) {
      ledger.advanceCursor(job.id, planned.now, result.status, safetyPatch);
    } else {
      ledger.recordJobHealth(job.id, planned.now, result.status, safetyPatch);
    }

    const wasFailing = (planned.prior_failures[job.id] || 0) > 0;
    if (result.status === "failed" && job.notify_on_failure) {
      await notifier.notifyFailure(job, result, ledger.consecutiveFailures(job.id));
    } else if (result.status === "success" && wasFailing && job.notify_on_recovery) {
      await notifier.notifyRecovery(job, result);
    }
  }

  const ranJobIds = new Set(planned.to_run.filter((item) => !item.manual).map((item) => item.job.id));
  for (const jobId of planned.evaluated_job_ids) {
    if (!ranJobIds.has(jobId)) {
      const lastStatus = (ledger.cursors[jobId] || {}).last_status || "success";
      ledger.advanceCursor(jobId, planned.now, lastStatus);
    }
  }

  ledger.pruneDedup(planned.now);
  const retentionDays = Math.max(...planned.to_run.map((item) => item.job.history_retention_days), 365);
  history.cleanupArchives(retentionDays, planned.now);
  ledger.recordHeartbeat(planned.now, "ok", `${planned.to_run.length} executed, ${planned.skipped_count} skipped`);

  return {
    now: planned.now,
    ran: results,
    skipped_count: planned.skipped_count,
    stale_claims_reconciled: planned.stale_claims_reconciled,
  };
}

module.exports = { DispatchError, plan, execute, failurePolicyPatch };
