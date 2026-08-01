"use strict";

const MAX_RESPONSE_BYTES = 64 * 1024;
const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function resolveHeaders(headers) {
  const resolved = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const match = typeof value === "string" ? value.match(ENV_REF) : null;
    resolved[key] = match ? process.env[match[1]] || "" : value;
  }
  return resolved;
}

async function readLimitedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (total < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_RESPONSE_BYTES - total;
    const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(slice);
    total += slice.byteLength;
    if (value.byteLength > remaining) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function execute(jobId, scheduledTimeIso, spec) {
  const executionId = `${jobId}:${scheduledTimeIso}`;
  const headers = resolveHeaders(spec.headers);
  if (!headers["User-Agent"]) headers["User-Agent"] = "self-hosted-cron-dispatcher/1.0";
  headers["X-Cron-Execution-Id"] = executionId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), spec.timeout_seconds * 1000);
  try {
    const response = await fetch(spec.url, {
      method: spec.method,
      headers,
      body: spec.body || undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    const snippet = await readLimitedBody(response);
    const statusOk = spec.expected_status.includes(response.status);
    const containsOk = spec.validate_contains ? snippet.includes(spec.validate_contains) : true;
    const parts = [`HTTP ${response.status}`];
    if (!statusOk) parts.push("unexpected status");
    if (!containsOk) parts.push("validate_contains not found");
    return { ok: statusOk && containsOk, detail: parts.join("; ") };
  } catch (err) {
    return { ok: false, detail: `request error: ${err.name || "Error"}` };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { MAX_RESPONSE_BYTES, resolveHeaders, execute };
