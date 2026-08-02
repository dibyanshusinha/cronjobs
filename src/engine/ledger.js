"use strict";

const { assertStateBackend } = require("./state-backend");
const { iso, parseIso } = require("./timeutil");

const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000;
const DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_CLAIM_GRACE_MS = 10 * 60 * 1000;

class Ledger {
  constructor(backend) {
    this.backend = assertStateBackend(backend, "Ledger backend");
    this.cursors = {};
    this.dedup = {};
    this.issues = {};
    this.heartbeat = {};
    this.dirty = new Set();
  }

  load() {
    this.cursors = this.backend.load("state/cursors", {});
    this.dedup = this.backend.load("state/dedup", { executed: {} });
    this.issues = this.backend.load("state/issues", {});
    this.heartbeat = this.backend.load("state/heartbeat", {});
    this.dirty.clear();
  }

  getCursor(jobId, now, lookbackMs = DEFAULT_LOOKBACK_MS) {
    const entry = this.cursors[jobId];
    if (!entry) return new Date(now.getTime() - lookbackMs);
    return parseIso(entry.last_evaluated_utc);
  }

  healthPatch(status, extra = {}) {
    const patch = { last_status: status };
    if (status === "success") {
      patch.consecutive_failures = 0;
      patch.failure_pause_until_utc = null;
      patch.auto_disabled = false;
      patch.auto_disabled_at_utc = null;
      patch.auto_disabled_reason = null;
    } else if (extra.consecutive_failures !== undefined) {
      patch.consecutive_failures = extra.consecutive_failures;
    }
    return { ...patch, ...extra };
  }

  recordJobHealth(jobId, when, status, extra = {}) {
    const prev = this.cursors[jobId] || {};
    let consecutiveFailures = prev.consecutive_failures || 0;
    if (status === "failed") consecutiveFailures += 1;
    if (status === "success") consecutiveFailures = 0;
    this.cursors[jobId] = { ...prev, ...this.healthPatch(status, { consecutive_failures: consecutiveFailures, ...extra }) };
    this.dirty.add("state/cursors");
  }

  advanceCursor(jobId, when, status, extra = {}) {
    this.recordJobHealth(jobId, when, status, { ...extra, last_evaluated_utc: iso(when) });
  }

  consecutiveFailures(jobId) {
    return (this.cursors[jobId] || {}).consecutive_failures || 0;
  }

  isAutoDisabled(jobId) {
    return Boolean((this.cursors[jobId] || {}).auto_disabled);
  }

  failurePauseUntil(jobId) {
    const value = (this.cursors[jobId] || {}).failure_pause_until_utc;
    return value ? parseIso(value) : null;
  }

  key(jobId, scheduledTime) {
    return `${jobId}|${iso(scheduledTime)}`;
  }

  isClaimed(jobId, scheduledTime) {
    return Boolean(this.dedup.executed[this.key(jobId, scheduledTime)]);
  }

  claim(jobId, scheduledTime, now) {
    this.dedup.executed[this.key(jobId, scheduledTime)] = {
      status: "running",
      claimed_at: iso(now),
      finished_at: null,
    };
    this.dirty.add("state/dedup");
  }

  reconcileStaleClaims(now, graceMs = STALE_CLAIM_GRACE_MS) {
    const affected = [];
    for (const [key, entry] of Object.entries(this.dedup.executed)) {
      if (entry.status !== "running") continue;
      const claimedAt = parseIso(entry.claimed_at);
      if (now.getTime() - claimedAt.getTime() >= graceMs) {
        entry.status = "failed";
        entry.finished_at = iso(now);
        affected.push(key);
      }
    }
    if (affected.length) this.dirty.add("state/dedup");
    return affected;
  }

  finalize(jobId, scheduledTime, status, finishedAt) {
    const key = this.key(jobId, scheduledTime);
    const entry = this.dedup.executed[key] || { status: "running", claimed_at: iso(finishedAt) };
    entry.status = status;
    entry.finished_at = iso(finishedAt);
    this.dedup.executed[key] = entry;
    this.dirty.add("state/dedup");
  }

  pruneDedup(now) {
    const cutoff = now.getTime() - DEDUP_RETENTION_MS;
    const kept = {};
    for (const [key, entry] of Object.entries(this.dedup.executed)) {
      const stamp = entry.finished_at || entry.claimed_at;
      const ts = stamp ? parseIso(stamp).getTime() : now.getTime();
      if (ts >= cutoff) kept[key] = entry;
    }
    if (Object.keys(kept).length !== Object.keys(this.dedup.executed).length) {
      this.dirty.add("state/dedup");
    }
    this.dedup.executed = kept;
  }

  openIssueNumber(jobId) {
    return (this.issues[jobId] || {}).issue_number ?? null;
  }

  recordOpenIssue(jobId, issueNumber, openedAt) {
    this.issues[jobId] = { issue_number: issueNumber, opened_at: iso(openedAt) };
    this.dirty.add("state/issues");
  }

  clearIssue(jobId) {
    if (this.issues[jobId]) {
      delete this.issues[jobId];
      this.dirty.add("state/issues");
    }
  }

  recordHeartbeat(now, status, detail = "") {
    this.heartbeat = { last_run_utc: iso(now), status, detail: detail.slice(0, 200) };
    this.dirty.add("state/heartbeat");
  }

  dirtyNames() {
    return new Set(this.dirty);
  }

  flush(only = null) {
    const names = [...this.dirty].filter((name) => !only || only.has(name)).sort();
    const dataByName = {
      "state/cursors": this.cursors,
      "state/dedup": this.dedup,
      "state/issues": this.issues,
      "state/heartbeat": this.heartbeat,
    };
    for (const name of names) this.backend.save(name, dataByName[name]);
    for (const name of names) this.dirty.delete(name);
    return names;
  }
}

module.exports = { Ledger, DEFAULT_LOOKBACK_MS, DEDUP_RETENTION_MS, STALE_CLAIM_GRACE_MS };
