"use strict";

const fs = require("fs");
const path = require("path");

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function loadSecretFiles(dir = process.env.SECRETS_DIR || "/run/secrets") {
  if (!dir || !fs.existsSync(dir)) return [];
  const loaded = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const key = entry.name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!key || process.env[key]) continue;
    process.env[key] = fs.readFileSync(path.join(dir, entry.name), "utf8").trimEnd();
    loaded.push(key);
  }
  return loaded;
}

function loadConfig(repoRoot = path.resolve(__dirname, "../../..")) {
  loadSecretFiles();
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(repoRoot, "data"));
  return {
    repoRoot,
    dataDir,
    stateBackend: process.env.STATE_BACKEND || "sqlite",
    dbPath: path.resolve(process.env.SQLITE_PATH || path.join(dataDir, "cronjobs.sqlite")),
    jobsDir: path.resolve(process.env.JOBS_DIR || path.join(repoRoot, "jobs")),
    scriptsRoot: path.resolve(process.env.SCRIPTS_ROOT || repoRoot),
    host: process.env.HOST || "0.0.0.0",
    port: intEnv("PORT", 8080),
    pollSeconds: intEnv("POLL_SECONDS", 60),
    maxConcurrency: intEnv("MAX_CONCURRENCY", 5),
    dashboardUser: process.env.DASHBOARD_USER || "admin",
    dashboardPassword: process.env.DASHBOARD_PASSWORD || "",
    dashboardToken: process.env.DASHBOARD_TOKEN || "",
    allowNoAuth: boolEnv("ALLOW_NO_AUTH", false),
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || "",
  };
}

module.exports = { boolEnv, intEnv, loadSecretFiles, loadConfig };
