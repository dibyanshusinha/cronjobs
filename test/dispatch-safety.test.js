"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dispatch = require("../src/engine/dispatch");

function dt(value) {
  return new Date(`${value}Z`);
}

test("failure policy applies exponential backoff", () => {
  const job = {
    id: "job-a",
    failure_policy: {
      auto_disable_after_consecutive_failures: 5,
      initial_backoff_seconds: 60,
      backoff_multiplier: 2,
      max_backoff_seconds: 3600,
    },
  };
  const planned = {
    now: dt("2026-01-01T00:00:00"),
    prior_failures: { "job-a": 2 },
  };
  const patch = dispatch.failurePolicyPatch(job, planned, { status: "failed" });
  assert.equal(patch.consecutive_failures, 3);
  assert.equal(patch.failure_pause_until_utc, "2026-01-01T00:04:00.000Z");
  assert.equal(patch.auto_disabled, false);
});

test("failure policy auto-disables after threshold", () => {
  const job = {
    id: "job-a",
    failure_policy: {
      auto_disable_after_consecutive_failures: 3,
      initial_backoff_seconds: 60,
      backoff_multiplier: 2,
      max_backoff_seconds: 3600,
    },
  };
  const planned = {
    now: dt("2026-01-01T00:00:00"),
    prior_failures: { "job-a": 2 },
  };
  const patch = dispatch.failurePolicyPatch(job, planned, { status: "failed" });
  assert.equal(patch.consecutive_failures, 3);
  assert.equal(patch.auto_disabled, true);
  assert.equal(patch.auto_disabled_reason, "3 consecutive failures");
});

test("failure policy clears safety state on success", () => {
  const patch = dispatch.failurePolicyPatch({ id: "job-a" }, { now: dt("2026-01-01T00:00:00"), prior_failures: {} }, { status: "success" });
  assert.deepEqual(patch, {});
});
