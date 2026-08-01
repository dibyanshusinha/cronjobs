"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Ledger } = require("../src/engine/ledger");
const { JsonFileStateBackend } = require("../src/engine/state-backend");

function dt(value) {
  return new Date(`${value}Z`);
}

function makeLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-ledger-"));
  const ledger = new Ledger(new JsonFileStateBackend(dir));
  ledger.load();
  return ledger;
}

test("getCursor defaults to rolling lookback for new job", () => {
  const ledger = makeLedger();
  const now = dt("2026-01-01T12:00:00");
  assert.equal(ledger.getCursor("new-job", now, 15 * 60 * 1000).toISOString(), "2026-01-01T11:45:00.000Z");
});

test("advanceCursor persists and is read back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-ledger-"));
  const ledger = new Ledger(new JsonFileStateBackend(dir));
  ledger.load();
  const now = dt("2026-01-01T12:00:00");
  ledger.advanceCursor("job-a", now, "success");
  assert.equal(ledger.dirtyNames().has("state/cursors"), true);
  ledger.flush();
  const ledger2 = new Ledger(new JsonFileStateBackend(dir));
  ledger2.load();
  assert.equal(ledger2.getCursor("job-a", dt("2026-01-01T13:00:00")).toISOString(), now.toISOString());
});

test("consecutiveFailures tracks streak", () => {
  const ledger = makeLedger();
  const now = dt("2026-01-01T12:00:00");
  ledger.advanceCursor("job-a", now, "failed");
  ledger.advanceCursor("job-a", now, "failed");
  assert.equal(ledger.consecutiveFailures("job-a"), 2);
  ledger.advanceCursor("job-a", now, "success");
  assert.equal(ledger.consecutiveFailures("job-a"), 0);
});

test("claim then isClaimed", () => {
  const ledger = makeLedger();
  const now = dt("2026-01-01T12:00:00");
  const occ = dt("2026-01-01T12:15:00");
  assert.equal(ledger.isClaimed("job-a", occ), false);
  ledger.claim("job-a", occ, now);
  assert.equal(ledger.isClaimed("job-a", occ), true);
});

test("finalize keeps claimed true", () => {
  const ledger = makeLedger();
  const now = dt("2026-01-01T12:00:00");
  const occ = dt("2026-01-01T12:15:00");
  ledger.claim("job-a", occ, now);
  ledger.finalize("job-a", occ, "success", now);
  assert.equal(ledger.isClaimed("job-a", occ), true);
  assert.equal(ledger.dedup.executed[`job-a|${occ.toISOString()}`].status, "success");
});

test("reconcileStaleClaims flips old running to failed", () => {
  const ledger = makeLedger();
  const claimedAt = dt("2026-01-01T12:00:00");
  const occ = dt("2026-01-01T12:15:00");
  ledger.claim("job-a", occ, claimedAt);
  assert.deepEqual(ledger.reconcileStaleClaims(dt("2026-01-01T12:01:00"), 10 * 60 * 1000), []);
  const affected = ledger.reconcileStaleClaims(dt("2026-01-01T12:11:00"), 10 * 60 * 1000);
  assert.equal(affected.length, 1);
  assert.equal(ledger.dedup.executed[ledger.key("job-a", occ)].status, "failed");
});

test("pruneDedup removes old entries", () => {
  const ledger = makeLedger();
  const oldTime = dt("2026-01-01T00:00:00");
  ledger.claim("job-a", oldTime, oldTime);
  ledger.finalize("job-a", oldTime, "success", oldTime);
  ledger.pruneDedup(dt("2026-01-31T00:00:00"));
  assert.deepEqual(ledger.dedup.executed, {});
});

test("pruneDedup keeps recent entries", () => {
  const ledger = makeLedger();
  const recent = dt("2026-01-01T00:00:00");
  ledger.claim("job-a", recent, recent);
  ledger.finalize("job-a", recent, "success", recent);
  ledger.pruneDedup(dt("2026-01-01T01:00:00"));
  assert.equal(Object.keys(ledger.dedup.executed).length, 1);
});

test("issue tracking round trip", () => {
  const ledger = makeLedger();
  const now = dt("2026-01-01T12:00:00");
  assert.equal(ledger.openIssueNumber("job-a"), null);
  ledger.recordOpenIssue("job-a", 42, now);
  assert.equal(ledger.openIssueNumber("job-a"), 42);
  ledger.clearIssue("job-a");
  assert.equal(ledger.openIssueNumber("job-a"), null);
});

test("heartbeat always marks dirty", () => {
  const ledger = makeLedger();
  ledger.recordHeartbeat(dt("2026-01-01T12:00:00"), "ok", "0 executed");
  assert.equal(ledger.dirtyNames().has("state/heartbeat"), true);
  assert.equal(ledger.heartbeat.status, "ok");
});

test("flush only writes requested names", () => {
  const ledger = makeLedger();
  const now = dt("2026-01-01T12:00:00");
  ledger.claim("job-a", now, now);
  ledger.recordHeartbeat(now, "ok");
  assert.deepEqual(ledger.flush(new Set(["state/dedup"])), ["state/dedup"]);
  assert.equal(ledger.dirtyNames().has("state/heartbeat"), true);
});
