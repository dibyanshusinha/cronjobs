"use strict";

const { assertStateBackend } = require("./state-backend");

const MAX_DETAIL_CHARS = 300;
const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASS|KEY|AUTH|CREDENTIAL)/i;

function sensitiveValues() {
  return Object.entries(process.env)
    .filter(([key, value]) => SENSITIVE_KEY.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

function redactSensitive(text) {
  let redacted = String(text || "");
  for (const value of sensitiveValues()) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function sanitize(result) {
  return {
    ...result,
    detail: redactSensitive(result.detail).slice(0, MAX_DETAIL_CHARS),
  };
}

class HistoryStore {
  constructor(backend) {
    this.backend = assertStateBackend(backend, "HistoryStore backend");
  }

  name(jobId) {
    return `history/${jobId}`;
  }

  append(jobId, result, limit) {
    this.appendArchive(jobId, result);
    const data = this.backend.load(this.name(jobId), { runs: [] });
    data.runs.push(sanitize(result));
    data.runs = data.runs.slice(-limit);
    this.backend.save(this.name(jobId), data);
  }

  appendSkipped(jobId, scheduledTimeIso, reason) {
    const skipped = {
      job_id: jobId,
      scheduled_time: scheduledTimeIso,
      status: "skipped",
      started_at: null,
      finished_at: null,
      duration_ms: null,
      attempts: 0,
      detail: reason.slice(0, MAX_DETAIL_CHARS),
      trigger: "scheduled",
      run_url: null,
    };
    this.appendArchive(jobId, skipped);
    const data = this.backend.load(this.name(jobId), { runs: [] });
    data.runs.push(skipped);
    data.runs = data.runs.slice(-200);
    this.backend.save(this.name(jobId), data);
  }

  recent(jobId, limit = 10) {
    const data = this.backend.load(this.name(jobId), { runs: [] });
    return data.runs.slice(-limit);
  }

  list() {
    if (!this.backend.list) return [];
    return this.backend.list("history")
      .filter((name) => /^history\/[^/]+$/.test(name))
      .map((name) => name.slice("history/".length))
      .sort();
  }

  archiveName(jobId, result) {
    const stamp = result.finished_at || result.scheduled_time || new Date().toISOString();
    const month = stamp.slice(0, 7);
    return `history/archive/${month}/${jobId}`;
  }

  appendArchive(jobId, result) {
    const name = this.archiveName(jobId, result);
    const data = this.backend.load(name, { runs: [] });
    data.runs.push(sanitize(result));
    this.backend.save(name, data);
  }

  cleanupArchives(retentionDays, now) {
    if (!this.backend.list || !this.backend.delete) return [];
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted = [];
    for (const name of this.backend.list("history/archive")) {
      const data = this.backend.load(name, { runs: [] });
      const keptRuns = data.runs.filter((run) => {
        const stamp = run.finished_at || run.scheduled_time;
        return stamp && new Date(stamp).getTime() >= cutoff;
      });
      if (keptRuns.length === 0) {
        this.backend.delete(name);
        deleted.push(name);
      } else if (keptRuns.length !== data.runs.length) {
        this.backend.save(name, { runs: keptRuns });
      }
    }
    return deleted;
  }
}

module.exports = { HistoryStore, MAX_DETAIL_CHARS };
