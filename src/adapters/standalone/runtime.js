"use strict";

const path = require("path");
const dashboard = require("../../engine/dashboard");
const discovery = require("../../engine/discovery");
const dispatch = require("../../engine/dispatch");
const schema = require("../../engine/schema");
const { HistoryStore } = require("../../engine/history");
const { Ledger } = require("../../engine/ledger");
const { StandaloneNotifier } = require("./notifier");
const { createStateBackend } = require("./state-backend-factory");

function loadJobs(config) {
  return discovery.discoverJobs(config.jobsDir);
}

function loadOverrides(backend) {
  return backend.load("state/standalone-overrides", { jobs: {} });
}

function saveOverrides(backend, overrides) {
  backend.save("state/standalone-overrides", overrides);
}

function applyOverrides(jobs, overrides) {
  const map = overrides.jobs || {};
  return jobs.map((job) => {
    const override = map[job.id] || {};
    if (override.enabled === undefined) return job;
    return { ...job, enabled: Boolean(override.enabled) };
  });
}

class StandaloneRuntime {
  constructor(config, backend = createStateBackend(config)) {
    this.config = config;
    this.backend = backend;
    this.ledger = new Ledger(backend);
    this.history = new HistoryStore(backend);
    this.notifier = new StandaloneNotifier({ webhookUrl: config.webhookUrl });
    this.inFlight = false;
    this.timer = null;
    this.lastError = null;
  }

  loadState() {
    this.ledger.load();
  }

  jobs() {
    return applyOverrides(loadJobs(this.config), loadOverrides(this.backend));
  }

  summary(now = new Date()) {
    this.loadState();
    return dashboard.buildSummary(this.jobs(), this.ledger, this.history, now);
  }

  readiness() {
    try {
      this.jobs();
      this.backend.save("state/readiness-check", { ok: true, checked_at: new Date().toISOString() });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  setEnabled(jobId, enabled) {
    const jobs = loadJobs(this.config);
    if (!jobs.some((job) => job.id === jobId)) {
      const err = new Error(`unknown job id '${jobId}'`);
      err.statusCode = 404;
      throw err;
    }
    const overrides = loadOverrides(this.backend);
    overrides.jobs[jobId] = { ...(overrides.jobs[jobId] || {}), enabled: Boolean(enabled) };
    saveOverrides(this.backend, overrides);
    return overrides.jobs[jobId];
  }

  async tick(options = {}) {
    if (this.inFlight) return { skipped: true, reason: "scheduler already running" };
    this.inFlight = true;
    const now = options.now || new Date();
    try {
      this.loadState();
      const jobs = this.jobs();
      const planned = dispatch.plan(jobs, this.ledger, this.history, now, {
        jobId: options.jobId || null,
        forceDisabled: Boolean(options.forceDisabled),
      });
      this.ledger.flush(new Set(["state/dedup"]));
      const summary = await dispatch.execute(planned, this.ledger, this.history, this.notifier, this.config.scriptsRoot, {
        maxConcurrency: this.config.maxConcurrency,
        runUrl: null,
      });
      this.ledger.flush();
      this.lastError = null;
      return summary;
    } catch (err) {
      if (err instanceof discovery.DiscoveryError || err instanceof schema.ValidationError) {
        this.ledger.recordHeartbeat(now, "validation_failed", err.message);
        this.ledger.flush(new Set(["state/heartbeat"]));
      }
      this.lastError = err;
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error(`standalone scheduler tick failed: ${err.message || String(err)}`);
      });
    }, this.config.pollSeconds * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.backend.close?.();
  }
}

module.exports = {
  StandaloneRuntime,
  applyOverrides,
  loadOverrides,
  saveOverrides,
};
