"use strict";

const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HISTORY_RETENTION_DAYS,
  DEFAULT_FAILURE_POLICY,
  DEFAULT_MISFIRE_CAP,
  DEFAULT_MISFIRE_POLICY,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_BACKOFF_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_TIMEZONE,
  buildHttpSpec,
  buildScriptSpec,
} = require("./models");

class ValidationError extends Error {}

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/job.schema.json");
let validateFn = null;

function loadValidator() {
  if (!validateFn) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validateFn = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return validateFn;
}

function validateMerged(merged, filePath) {
  const validate = loadValidator();
  if (validate(merged)) return;
  const messages = validate.errors.map((err) => {
    const loc = err.instancePath ? err.instancePath.slice(1).replaceAll("/", "/") : "<root>";
    return `${filePath}: ${err.message} (at ${loc})`;
  });
  throw new ValidationError(messages.join("\n"));
}

function buildJob(merged, filePath) {
  const notify = merged.notify || {};
  const topTimeout = merged.timeout_seconds || DEFAULT_TIMEOUT_SECONDS;
  const job = {
    id: merged.id,
    schedule: merged.schedule,
    type: merged.type,
    file_path: String(filePath),
    name: merged.name || merged.id,
    description: merged.description || "",
    timezone: merged.timezone || DEFAULT_TIMEZONE,
    enabled: merged.enabled ?? true,
    retries: merged.retries ?? DEFAULT_RETRIES,
    retry_backoff_seconds: merged.retry_backoff_seconds ?? DEFAULT_RETRY_BACKOFF_SECONDS,
    timeout_seconds: topTimeout,
    misfire_policy: merged.misfire_policy || DEFAULT_MISFIRE_POLICY,
    misfire_cap: merged.misfire_cap || DEFAULT_MISFIRE_CAP,
    history_limit: merged.history_limit || DEFAULT_HISTORY_LIMIT,
    history_retention_days: merged.history_retention_days || DEFAULT_HISTORY_RETENTION_DAYS,
    failure_policy: { ...DEFAULT_FAILURE_POLICY, ...(merged.failure_policy || {}) },
    notify_on_failure: notify.on_failure ?? true,
    notify_on_recovery: notify.on_recovery ?? true,
    http: null,
    script: null,
  };
  if (merged.type === "http") {
    job.http = buildHttpSpec(merged.http, topTimeout);
  } else {
    job.script = buildScriptSpec(merged.script, topTimeout);
  }
  return job;
}

function checkDuplicateIds(jobs) {
  const seen = new Map();
  const dupes = [];
  for (const job of jobs) {
    if (seen.has(job.id)) {
      dupes.push(`duplicate job id '${job.id}': ${seen.get(job.id)} and ${job.file_path}`);
    } else {
      seen.set(job.id, job.file_path);
    }
  }
  if (dupes.length) throw new ValidationError(dupes.join("\n"));
}

module.exports = { ValidationError, validateMerged, buildJob, checkDuplicateIds };
