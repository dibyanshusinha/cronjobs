"use strict";

const fs = require("fs");
const path = require("path");
const dashboard = require("../../engine/dashboard");
const discovery = require("../../engine/discovery");
const dispatch = require("../../engine/dispatch");
const schema = require("../../engine/schema");
const { HistoryStore } = require("../../engine/history");
const { Ledger } = require("../../engine/ledger");
const { JsonFileStateBackend } = require("../../engine/state-backend");
const { GitCommitter } = require("./git-branch-state");
const { GitHubIssuesNotifier } = require("./issues-notifier");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SITE_SOURCE = path.join(REPO_ROOT, "adapters/github/site");

function envBool(name, defaultValue = false) {
  const val = process.env[name];
  if (val === undefined || val === "") return defaultValue;
  return ["1", "true", "yes"].includes(val.trim().toLowerCase());
}

function currentRunUrl() {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (server && repo && runId) return `${server}/${repo}/actions/runs/${runId}`;
  return null;
}

function syncSiteShell(stateDir) {
  const docsDir = path.join(stateDir, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  for (const item of fs.readdirSync(SITE_SOURCE)) {
    fs.copyFileSync(path.join(SITE_SOURCE, item), path.join(docsDir, item));
  }
}

async function main() {
  const stateDir = path.resolve(process.env.STATE_DIR);
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const jobId = process.env.JOB_ID || null;
  const forceDisabled = envBool("FORCE_DISABLED");
  const maxConcurrency = Number.parseInt(process.env.MAX_CONCURRENCY || "5", 10);

  const backend = new JsonFileStateBackend(stateDir);
  const ledger = new Ledger(backend);
  ledger.load();
  const history = new HistoryStore(backend);
  const committer = new GitCommitter(stateDir);
  const now = new Date();

  let jobs;
  try {
    jobs = discovery.discoverJobs(path.join(REPO_ROOT, "jobs"));
  } catch (err) {
    if (err instanceof discovery.DiscoveryError || err instanceof schema.ValidationError) {
      console.error("Job validation failed - dispatcher not running this tick:");
      console.error(err.message);
      ledger.recordHeartbeat(now, "validation_failed", err.message);
      ledger.flush(new Set(["state/heartbeat"]));
      committer.commitAndPush(["."], `chore: heartbeat (validation failed) @ ${now.toISOString()}`);
      return 1;
    }
    throw err;
  }

  const notifier = new GitHubIssuesNotifier(ledger, repo, token);
  let planned;
  try {
    planned = dispatch.plan(jobs, ledger, history, now, { jobId, forceDisabled });
  } catch (err) {
    if (err instanceof dispatch.DispatchError) {
      console.error(`Dispatch error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  ledger.flush(new Set(["state/dedup"]));
  committer.commitAndPush(["."], `chore: claim ${planned.to_run.length} occurrence(s) @ ${now.toISOString()}`);

  const summary = await dispatch.execute(planned, ledger, history, notifier, REPO_ROOT, {
    maxConcurrency,
    runUrl: currentRunUrl(),
  });

  backend.save("docs/dashboard-data/summary", dashboard.buildSummary(jobs, ledger, history, now));
  syncSiteShell(stateDir);

  ledger.flush();
  committer.commitAndPush(
    ["."],
    `chore: dispatcher run @ ${now.toISOString()} - ${summary.ran.length} executed, ${summary.skipped_count} skipped`
  );

  const failed = summary.ran.filter((result) => result.status === "failed").length;
  console.log(
    `Dispatcher run complete: ${summary.ran.length} executed (${failed} failed), ` +
      `${summary.skipped_count} skipped, ${summary.stale_claims_reconciled.length} stale claim(s) reconciled.`
  );
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { main, syncSiteShell, currentRunUrl };
