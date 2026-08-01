"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const scheduler = require("../src/engine/scheduler");

function dt(value) {
  return new Date(`${value}Z`);
}

test("computeDueOccurrences basic window", () => {
  const occurrences = scheduler.computeDueOccurrences(
    "*/15 * * * *",
    "UTC",
    dt("2026-01-01T00:00:00"),
    dt("2026-01-01T00:31:00")
  );
  assert.deepEqual(
    occurrences.map((date) => date.toISOString()),
    ["2026-01-01T00:15:00.000Z", "2026-01-01T00:30:00.000Z"]
  );
});

test("computeDueOccurrences empty window yields nothing", () => {
  const occurrences = scheduler.computeDueOccurrences(
    "0 3 * * *",
    "UTC",
    dt("2026-01-01T00:00:00"),
    dt("2026-01-01T00:05:00")
  );
  assert.deepEqual(occurrences, []);
});

test("computeDueOccurrences since is exclusive", () => {
  const occurrences = scheduler.computeDueOccurrences(
    "*/15 * * * *",
    "UTC",
    dt("2026-01-01T00:15:00"),
    dt("2026-01-01T00:15:00")
  );
  assert.deepEqual(occurrences, []);
});

test("computeDueOccurrences timezone aware", () => {
  const occurrences = scheduler.computeDueOccurrences(
    "0 9 * * *",
    "Asia/Kolkata",
    dt("2026-01-01T00:00:00"),
    dt("2026-01-01T06:00:00")
  );
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].toISOString(), "2026-01-01T03:30:00.000Z");
});

test("misfire policy most_recent keeps only latest", () => {
  const occs = [dt("2026-01-01T00:00:00"), dt("2026-01-01T00:15:00"), dt("2026-01-01T00:30:00")];
  const [toRun, skipped] = scheduler.applyMisfirePolicy(occs, "most_recent", 10);
  assert.deepEqual(toRun, [occs[2]]);
  assert.deepEqual(skipped, occs.slice(0, -1));
});

test("misfire policy all under cap keeps everything", () => {
  const occs = [dt("2026-01-01T00:00:00"), dt("2026-01-01T00:15:00")];
  const [toRun, skipped] = scheduler.applyMisfirePolicy(occs, "all", 10);
  assert.deepEqual(toRun, occs);
  assert.deepEqual(skipped, []);
});

test("misfire policy all over cap trims oldest", () => {
  const occs = Array.from({ length: 12 }, (_, i) => dt(`2026-01-01T00:${String(i * 5).padStart(2, "0")}:00`));
  const [toRun, skipped] = scheduler.applyMisfirePolicy(occs, "all", 5);
  assert.deepEqual(toRun, occs.slice(-5));
  assert.deepEqual(skipped, occs.slice(0, -5));
});

test("misfire policy empty input", () => {
  assert.deepEqual(scheduler.applyMisfirePolicy([], "most_recent", 10), [[], []]);
});

test("misfire policy unknown raises", () => {
  assert.throws(() => scheduler.applyMisfirePolicy([dt("2026-01-01T00:00:00")], "bogus", 10), /unknown/);
});

test("nextDueAfter", () => {
  const next = scheduler.nextDueAfter("0 3 * * *", "UTC", dt("2026-01-01T00:00:00"));
  assert.equal(next.toISOString(), "2026-01-01T03:00:00.000Z");
});
