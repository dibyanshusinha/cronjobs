"use strict";

const path = require("path");
const discovery = require("./discovery");
const schema = require("./schema");
const {
  ScriptSecurityError,
  resolveInterpreter,
  resolveScriptPath,
} = require("./executors/script-executor");

const REPO_ROOT = path.resolve(__dirname, "../..");
const JOBS_ROOT = path.join(REPO_ROOT, "jobs");

function main() {
  let jobs;
  try {
    jobs = discovery.discoverJobs(JOBS_ROOT);
  } catch (err) {
    if (err instanceof discovery.DiscoveryError || err instanceof schema.ValidationError) {
      console.error("Job validation failed:\n");
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  const scriptErrors = [];
  for (const job of jobs) {
    if (job.type !== "script") continue;
    try {
      resolveScriptPath(REPO_ROOT, job.script.path);
      resolveInterpreter(job.script);
    } catch (err) {
      if (err instanceof ScriptSecurityError) {
        scriptErrors.push(`${job.file_path}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  if (scriptErrors.length) {
    console.error("Job validation failed:\n");
    console.error(scriptErrors.join("\n"));
    return 1;
  }

  console.log(`OK: ${jobs.length} job(s) validated under ${JOBS_ROOT}`);
  for (const job of [...jobs].sort((a, b) => a.id.localeCompare(b.id))) {
    const status = job.enabled ? "enabled" : "disabled";
    console.log(`  - ${job.id} [${job.type}, ${status}] schedule='${job.schedule}' tz=${job.timezone}`);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
