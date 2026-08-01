"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const schema = require("./schema");

const JOB_SUFFIX = ".job.yml";
const DEFAULTS_FILENAME = "_defaults.yml";
const ALLOWED_DEFAULT_KEYS = new Set([
  "timezone",
  "enabled",
  "retries",
  "retry_backoff_seconds",
  "timeout_seconds",
  "misfire_policy",
  "misfire_cap",
  "history_limit",
  "history_retention_days",
  "failure_policy",
  "notify",
]);

class DiscoveryError extends Error {}

function loadYaml(filePath) {
  const data = yaml.load(fs.readFileSync(filePath, "utf8")) || {};
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new DiscoveryError(`${filePath}: expected a YAML mapping at the top level`);
  }
  return data;
}

function shallowMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(entryPath));
    if (entry.isFile() && entry.name.endsWith(JOB_SUFFIX)) out.push(entryPath);
  }
  return out.sort();
}

function defaultsChainDirs(jobsRoot, jobDir) {
  const root = fs.realpathSync(jobsRoot);
  const dir = fs.realpathSync(jobDir);
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new DiscoveryError(`${dir} is not under jobs root ${root}`);
  }
  const parts = rel ? rel.split(path.sep) : [];
  const dirs = [root];
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    dirs.push(cur);
  }
  return dirs;
}

function loadDefaultsChain(jobsRoot, jobDir) {
  let merged = {};
  for (const dir of defaultsChainDirs(jobsRoot, jobDir)) {
    const defaultsPath = path.join(dir, DEFAULTS_FILENAME);
    if (!fs.existsSync(defaultsPath)) continue;
    const raw = loadYaml(defaultsPath);
    const unknown = Object.keys(raw).filter((key) => !ALLOWED_DEFAULT_KEYS.has(key));
    if (unknown.length) {
      throw new DiscoveryError(`${defaultsPath}: unknown default key(s) ${JSON.stringify(unknown.sort())}`);
    }
    merged = shallowMerge(merged, raw);
  }
  return merged;
}

function discoverJobs(jobsRoot) {
  if (!fs.existsSync(jobsRoot)) return [];
  const jobs = [];
  const errors = [];
  for (const jobFile of walk(jobsRoot)) {
    try {
      const raw = loadYaml(jobFile);
      const defaults = loadDefaultsChain(jobsRoot, path.dirname(jobFile));
      const merged = shallowMerge(defaults, raw);
      schema.validateMerged(merged, jobFile);
      jobs.push(schema.buildJob(merged, jobFile));
    } catch (err) {
      if (err instanceof DiscoveryError || err instanceof schema.ValidationError) {
        errors.push(err.message);
      } else {
        errors.push(`${jobFile}: ${err.message}`);
      }
    }
  }
  if (errors.length) throw new DiscoveryError(errors.join("\n"));
  schema.checkDuplicateIds(jobs);
  return jobs;
}

module.exports = {
  JOB_SUFFIX,
  DEFAULTS_FILENAME,
  DiscoveryError,
  loadYaml,
  shallowMerge,
  discoverJobs,
};
