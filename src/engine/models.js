"use strict";

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_RETRIES = 0;
const DEFAULT_RETRY_BACKOFF_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MISFIRE_POLICY = "most_recent";
const DEFAULT_MISFIRE_CAP = 10;
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_HISTORY_RETENTION_DAYS = 365;
const DEFAULT_FAILURE_POLICY = {
  auto_disable_after_consecutive_failures: 5,
  initial_backoff_seconds: 300,
  backoff_multiplier: 2,
  max_backoff_seconds: 21600,
};

function buildHttpSpec(raw, topTimeout) {
  return {
    url: raw.url,
    method: raw.method || "GET",
    headers: raw.headers || {},
    body: raw.body || "",
    expected_status: raw.expected_status || Array.from({ length: 100 }, (_, i) => i + 200),
    validate_contains: raw.validate_contains,
    timeout_seconds: raw.timeout_seconds || topTimeout,
  };
}

function buildScriptSpec(raw, topTimeout) {
  return {
    path: raw.path,
    args: raw.args || [],
    interpreter: raw.interpreter,
    timeout_seconds: raw.timeout_seconds || topTimeout,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_BACKOFF_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MISFIRE_POLICY,
  DEFAULT_MISFIRE_CAP,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HISTORY_RETENTION_DAYS,
  DEFAULT_FAILURE_POLICY,
  buildHttpSpec,
  buildScriptSpec,
};
