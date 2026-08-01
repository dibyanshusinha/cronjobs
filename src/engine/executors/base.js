"use strict";

const { iso } = require("../timeutil");
const httpExecutor = require("./http-executor");
const scriptExecutor = require("./script-executor");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry(job, scheduledTime, repoRoot) {
  const started = new Date();
  const scheduledIso = iso(scheduledTime);
  const maxAttempts = job.retries + 1;
  let ok = false;
  let detail = "";
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const result =
        job.type === "http"
          ? await httpExecutor.execute(job.id, scheduledIso, job.http)
          : await scriptExecutor.execute(job.id, job.script, repoRoot);
      ok = result.ok;
      detail = result.detail;
    } catch (err) {
      ok = false;
      detail = `executor error: ${err.name || "Error"}`;
    }
    if (ok || attempt === maxAttempts) break;
    await sleep(job.retry_backoff_seconds * 1000 * 2 ** (attempt - 1));
  }

  const finished = new Date();
  return {
    job_id: job.id,
    scheduled_time: scheduledIso,
    status: ok ? "success" : "failed",
    started_at: iso(started),
    finished_at: iso(finished),
    duration_ms: finished.getTime() - started.getTime(),
    attempts,
    detail,
    trigger: "scheduled",
    run_url: null,
  };
}

module.exports = { runWithRetry };
