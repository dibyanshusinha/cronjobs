"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const discovery = require("../src/engine/discovery");
const schema = require("../src/engine/schema");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-discovery-"));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("defaults inheritance precedence", () => {
  const root = path.join(tmpdir(), "jobs");
  write(path.join(root, "_defaults.yml"), "timezone: UTC\nretries: 1\n");
  write(path.join(root, "team-a", "_defaults.yml"), "timezone: Asia/Kolkata\n");
  write(
    path.join(root, "team-a", "a.job.yml"),
    "id: a\nschedule: '*/5 * * * *'\ntype: http\nhttp:\n  url: https://example.com\n"
  );
  const jobs = discovery.discoverJobs(root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].timezone, "Asia/Kolkata");
  assert.equal(jobs[0].retries, 1);
});

test("job own field overrides defaults", () => {
  const root = path.join(tmpdir(), "jobs");
  write(path.join(root, "_defaults.yml"), "retries: 5\n");
  write(
    path.join(root, "a.job.yml"),
    "id: a\nschedule: '*/5 * * * *'\ntype: http\nretries: 0\nhttp:\n  url: https://example.com\n"
  );
  assert.equal(discovery.discoverJobs(root)[0].retries, 0);
});

test("duplicate id across folders rejected", () => {
  const root = path.join(tmpdir(), "jobs");
  write(path.join(root, "a", "x.job.yml"), "id: dupe\nschedule: '* * * * *'\ntype: http\nhttp:\n  url: https://example.com\n");
  write(path.join(root, "b", "y.job.yml"), "id: dupe\nschedule: '* * * * *'\ntype: http\nhttp:\n  url: https://example.com\n");
  assert.throws(() => discovery.discoverJobs(root), schema.ValidationError);
});

test("unknown default key rejected", () => {
  const root = path.join(tmpdir(), "jobs");
  write(path.join(root, "_defaults.yml"), "id: not-allowed\n");
  write(path.join(root, "a.job.yml"), "id: a\nschedule: '* * * * *'\ntype: http\nhttp:\n  url: https://example.com\n");
  assert.throws(() => discovery.discoverJobs(root), /unknown default key/);
});

test("missing required field rejected", () => {
  const root = path.join(tmpdir(), "jobs");
  write(path.join(root, "a.job.yml"), "schedule: '* * * * *'\ntype: http\nhttp:\n  url: https://example.com\n");
  assert.throws(() => discovery.discoverJobs(root), discovery.DiscoveryError);
});

test("bad url scheme rejected by schema", () => {
  const root = path.join(tmpdir(), "jobs");
  write(path.join(root, "a.job.yml"), "id: a\nschedule: '* * * * *'\ntype: http\nhttp:\n  url: http://insecure.example.com\n");
  assert.throws(() => discovery.discoverJobs(root), discovery.DiscoveryError);
});

test("empty jobs dir returns empty list", () => {
  assert.deepEqual(discovery.discoverJobs(path.join(tmpdir(), "does-not-exist")), []);
});

test("notify defaults shallow merge", () => {
  const root = path.join(tmpdir(), "jobs");
  write(path.join(root, "_defaults.yml"), "notify:\n  on_failure: true\n  on_recovery: true\n");
  write(
    path.join(root, "a.job.yml"),
    "id: a\nschedule: '* * * * *'\ntype: http\nnotify:\n  on_recovery: false\nhttp:\n  url: https://example.com\n"
  );
  const job = discovery.discoverJobs(root)[0];
  assert.equal(job.notify_on_failure, true);
  assert.equal(job.notify_on_recovery, false);
});
