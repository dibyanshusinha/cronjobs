const DATA_URL = "dashboard-data/summary.json";
const HEARTBEAT_STALE_AFTER_MINUTES = 15;
const THEME_KEY = "cronjobs-theme";
const HISTORY_PAGE_SIZE = 5;
const JOBS_PAGE_SIZE = 8;
let dashboardData = null;
let jobsPage = 0;
let selectedJobId = null;
let jobFilter = "";
const WEEKDAYS = [
  ["0", "Sun"],
  ["1", "Mon"],
  ["2", "Tue"],
  ["3", "Wed"],
  ["4", "Thu"],
  ["5", "Fri"],
  ["6", "Sat"],
];

function preferredTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const button = document.getElementById("theme-toggle");
  if (button) {
    button.textContent = theme === "dark" ? "☀" : "☾";
    button.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    button.setAttribute("aria-label", button.title);
  }
}

function initTheme() {
  setTheme(preferredTheme());
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function viewerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (e) {
    return "UTC";
  }
}

function formatTime(isoStr, timeZone) {
  if (!isoStr) return null;
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch (e) {
    return null;
  }
}

function renderTime(isoStr, jobTz) {
  if (!isoStr) return `<span class="time-secondary">Never</span>`;
  const localTz = viewerTimeZone();
  const primary = formatTime(isoStr, jobTz || localTz) || isoStr;
  const local = localTz !== jobTz ? formatTime(isoStr, localTz) : null;
  return `
    <span title="${escapeHtml(isoStr)}">${escapeHtml(primary)}</span>
    ${local ? `<span class="time-secondary">${escapeHtml(local)}</span>` : ""}
  `;
}

function minutesAgo(isoStr) {
  if (!isoStr) return Infinity;
  return (Date.now() - new Date(isoStr).getTime()) / 60000;
}

function badge(status) {
  const value = status || "unknown";
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function triggerLabel(trigger) {
  if (!trigger) return "";
  return `<span class="detail">${escapeHtml(trigger)}</span>`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function slugify(value) {
  return String(value || "new-job")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128) || "new-job";
}

function yamlString(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function parseStatusList(value) {
  return String(value || "200")
    .split(/[,\s]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((num) => Number.isInteger(num) && num >= 100 && num <= 599);
}

function formData() {
  const form = document.getElementById("job-builder");
  return Object.fromEntries(new FormData(form).entries());
}

function skippedDays() {
  return new Set(
    [...document.querySelectorAll('input[name="skip_day"]:checked')].map((input) => input.value)
  );
}

function composeSchedule(baseSchedule) {
  const parts = String(baseSchedule || "").trim().split(/\s+/);
  const skipped = skippedDays();
  if (parts.length !== 5 || !skipped.size) return baseSchedule;
  const allowed = WEEKDAYS.map(([value]) => value).filter((value) => !skipped.has(value));
  if (!allowed.length) return baseSchedule;
  return [...parts.slice(0, 4), allowed.join(",")].join(" ");
}

function updateScheduleSummary(schedule) {
  const el = document.getElementById("schedule-summary");
  if (!el) return;
  const skipped = skippedDays();
  if (!skipped.size) {
    el.textContent = "Runs on every day selected by the cron expression.";
    return;
  }
  const allowed = WEEKDAYS.filter(([value]) => !skipped.has(value)).map(([, label]) => label);
  const skippedLabels = WEEKDAYS.filter(([value]) => skipped.has(value)).map(([, label]) => label);
  if (!allowed.length) {
    el.textContent = "At least one day must remain enabled. The cron expression was left unchanged.";
    return;
  }
  el.textContent = `Runs on ${allowed.join(", ")}. Skips ${skippedLabels.join(", ")}. Cron: ${schedule}`;
}

function readHeaderRows() {
  return [...document.querySelectorAll("#headers-list .header-row")]
    .map((row) => {
      const key = row.querySelector(".header-name")?.value.trim() || "";
      const value = row.querySelector(".header-value")?.value.trim() || "";
      return key ? [key, value] : null;
    })
    .filter(Boolean);
}

function updateHeaderEmptyState() {
  const list = document.getElementById("headers-list");
  if (!list) return;
  const empty = list.querySelector(".header-empty");
  const hasRows = Boolean(list.querySelector(".header-row"));
  if (empty) empty.hidden = hasRows;
}

function addHeaderRow(key = "", value = "") {
  const list = document.getElementById("headers-list");
  if (!list) return;
  const row = document.createElement("div");
  row.className = "header-row";
  row.innerHTML = `
    <label>Header name<input class="header-name" value="${escapeHtml(key)}" placeholder="Authorization" /></label>
    <label>Value<input class="header-value" value="${escapeHtml(value)}" placeholder="\${MY_SECRET}" /></label>
    <button type="button" class="icon-button remove-header" title="Remove header" aria-label="Remove header">×</button>
  `;
  row.querySelectorAll("input").forEach((input) => input.addEventListener("input", updateBuilder));
  row.querySelector(".remove-header").addEventListener("click", () => {
    row.remove();
    updateHeaderEmptyState();
    updateBuilder();
  });
  list.appendChild(row);
  updateHeaderEmptyState();
  updateBuilder();
}

function buildJobYaml(data) {
  const id = slugify(data.id);
  const lines = [
    `id: ${id}`,
    `name: ${yamlString(data.name || id)}`,
    `enabled: true`,
    `schedule: ${yamlString(data.schedule || "*/15 * * * *")}`,
    `timezone: ${yamlString(data.timezone || viewerTimeZone())}`,
    `type: ${data.type}`,
    `retries: ${Number.parseInt(data.retries || "0", 10)}`,
    `timeout_seconds: ${Number.parseInt(data.timeout || "30", 10)}`,
    `history_retention_days: ${Number.parseInt(data.retention || "365", 10)}`,
    `failure_policy:`,
    `  auto_disable_after_consecutive_failures: ${Number.parseInt(data.auto_disable || "5", 10)}`,
    `  initial_backoff_seconds: ${Number.parseInt(data.initial_backoff || "300", 10)}`,
    `  backoff_multiplier: ${Number.parseFloat(data.backoff_multiplier || "2")}`,
    `  max_backoff_seconds: ${Number.parseInt(data.max_backoff || "21600", 10)}`,
  ];

  if (data.type === "http") {
    const statuses = parseStatusList(data.expected_status);
    lines.push(`http:`);
    lines.push(`  method: ${data.method || "GET"}`);
    lines.push(`  url: ${yamlString(data.url || "https://example.com")}`);
    lines.push(`  expected_status: [${(statuses.length ? statuses : [200]).join(", ")}]`);
    const headers = readHeaderRows();
    if (headers.length) {
      lines.push(`  headers:`);
      for (const [key, value] of headers) lines.push(`    ${key}: ${yamlString(value)}`);
    }
    if (data.body) {
      lines.push(`  body: |-`);
      for (const line of String(data.body).split(/\r?\n/)) lines.push(`    ${line}`);
    }
  } else {
    const args = String(data.args || "")
      .split(/\s+/)
      .map((arg) => arg.trim())
      .filter(Boolean);
    lines.push(`script:`);
    lines.push(`  path: ${yamlString(data.script_path || "scripts/examples/backup_check.sh")}`);
    lines.push(`  interpreter: ${data.interpreter || "bash"}`);
    if (args.length) lines.push(`  args: [${args.map(yamlString).join(", ")}]`);
  }
  return `${lines.join("\n")}\n`;
}

function jobFilePath(data) {
  const folder = String(data.folder || "").trim().replace(/^\/+|\/+$/g, "");
  const safeFolder = folder
    .split("/")
    .map((part) => slugify(part))
    .filter(Boolean)
    .join("/");
  return `jobs/${safeFolder ? `${safeFolder}/` : ""}${slugify(data.id)}.job.yml`;
}

function cronValues(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-").map((x) => Number.parseInt(x, 10));
        start = a;
        end = b;
      } else {
        start = Number.parseInt(rangePart, 10);
        end = start;
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step < 1) return null;
    for (let value = start; value <= end; value += step) {
      if (value >= min && value <= max) values.add(value);
    }
  }
  return values;
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number.parseInt(get("minute"), 10),
    hour: Number.parseInt(get("hour"), 10),
    day: Number.parseInt(get("day"), 10),
    month: Number.parseInt(get("month"), 10),
    dow: weekdays[get("weekday")],
  };
}

function cronMatches(date, schedule, timeZone) {
  const parts = String(schedule || "").trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = [
    cronValues(parts[0], 0, 59),
    cronValues(parts[1], 0, 23),
    cronValues(parts[2], 1, 31),
    cronValues(parts[3], 1, 12),
    cronValues(parts[4], 0, 7),
  ];
  if (!minute || !hour || !dom || !month || !dow) return false;
  const local = zonedParts(date, timeZone || viewerTimeZone());
  const day = local.dow;
  return (
    minute.has(local.minute) &&
    hour.has(local.hour) &&
    dom.has(local.day) &&
    month.has(local.month) &&
    (dow.has(day) || (day === 0 && dow.has(7)))
  );
}

function simulateRuns(schedule, timeZone, limit = 8) {
  const runs = [];
  const cursor = new Date();
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60 && runs.length < limit; i += 1) {
    if (cronMatches(cursor, schedule, timeZone)) runs.push(new Date(cursor));
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return runs;
}

function updateBuilder() {
  const data = formData();
  document.getElementById("http-fields").hidden = data.type !== "http";
  document.getElementById("script-fields").hidden = data.type !== "script";
  if (data.preset && data.preset !== "custom") {
    data.schedule = composeSchedule(data.preset);
    document.querySelector('[name="schedule"]').value = data.schedule;
  } else if (skippedDays().size) {
    data.schedule = composeSchedule(data.schedule);
    document.querySelector('[name="schedule"]').value = data.schedule;
  }
  updateScheduleSummary(data.schedule);
  if (!document.querySelector('[name="timezone"]').value) {
    document.querySelector('[name="timezone"]').value = viewerTimeZone();
    data.timezone = viewerTimeZone();
  }
  document.getElementById("job-path").textContent = jobFilePath(data);
  document.getElementById("yaml-output").textContent = buildJobYaml(data);
  document.getElementById("test-job").disabled = data.type !== "http";
}

function simulateBuilderSchedule() {
  const data = formData();
  const runs = simulateRuns(data.schedule, data.timezone || viewerTimeZone());
  const output = document.getElementById("schedule-output");
  if (!runs.length) {
    output.textContent = "Could not simulate this expression in the browser. The dispatcher still validates it with the Node scheduler.";
    return;
  }
  output.innerHTML = runs
    .map((run) => `<div>${renderTime(run.toISOString(), data.timezone || viewerTimeZone())}</div>`)
    .join("");
}

async function performBuilderHttpTest() {
  const data = formData();
  const output = document.getElementById("test-output");
  if (data.type !== "http") {
    output.textContent = "Script jobs cannot run from the static dashboard. Paste the YAML, then run npm run validate.";
    return;
  }
  if (!document.querySelector('[name="send_test"]').checked) {
    output.textContent = "Check the opt-in box first. The test sends one real request from your browser/network IP.";
    return;
  }
  output.textContent = "Testing...";
  const started = performance.now();
  try {
    const response = await fetch(data.url, {
      method: data.method || "GET",
      headers: Object.fromEntries(readHeaderRows()),
      body: data.body && !["GET", "HEAD"].includes(data.method) ? data.body : undefined,
      cache: "no-store",
    });
    const elapsed = Math.round(performance.now() - started);
    const ok = parseStatusList(data.expected_status).includes(response.status);
    output.innerHTML = `${badge(ok ? "success" : "failed")} <span class="detail">HTTP ${response.status} in ${elapsed} ms from this browser. Scheduled runs will come from GitHub Actions.</span>`;
  } catch (err) {
    output.innerHTML = `${badge("failed")} <span class="detail">${escapeHtml(err.message || String(err))}. Browser tests may fail because of CORS even when the dispatcher can call the URL from GitHub Actions.</span>`;
  }
}

function testBuilderJob() {
  const data = formData();
  const output = document.getElementById("test-output");
  if (data.type !== "http") {
    output.textContent = "Script jobs cannot run from the static dashboard. Paste the YAML, then run npm run validate.";
    return;
  }
  if (!document.querySelector('[name="send_test"]').checked) {
    output.textContent = "Check the opt-in box first. The test sends one real request from your browser/network IP.";
    return;
  }
  const dialog = document.getElementById("test-confirm-modal");
  document.getElementById("test-confirm-url").textContent = data.url || "No URL configured";
  if (dialog?.showModal) dialog.showModal();
  else dialog?.setAttribute("open", "");
}

async function copyBuilderYaml() {
  const yaml = document.getElementById("yaml-output").textContent;
  const output = document.getElementById("test-output");
  try {
    await navigator.clipboard.writeText(yaml);
    output.textContent = "YAML copied.";
  } catch (err) {
    output.textContent = "Copy failed. Select the YAML block and copy it manually.";
  }
}

function initBuilder() {
  const form = document.getElementById("job-builder");
  if (!form) return;
  const dialog = document.getElementById("job-modal");
  const openButton = document.getElementById("open-builder");
  const closeButton = document.getElementById("close-builder");
  form.addEventListener("input", updateBuilder);
  form.addEventListener("change", updateBuilder);
  openButton?.addEventListener("click", () => {
    if (dialog?.showModal) dialog.showModal();
    else dialog?.setAttribute("open", "");
    updateBuilder();
  });
  closeButton?.addEventListener("click", () => dialog?.close());
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.getElementById("add-header").addEventListener("click", () => addHeaderRow());
  document.getElementById("simulate-job").addEventListener("click", simulateBuilderSchedule);
  document.getElementById("test-job").addEventListener("click", testBuilderJob);
  document.getElementById("cancel-test").addEventListener("click", () => document.getElementById("test-confirm-modal").close());
  document.getElementById("confirm-test").addEventListener("click", () => {
    document.getElementById("test-confirm-modal").close();
    performBuilderHttpTest();
  });
  document.getElementById("copy-yaml").addEventListener("click", copyBuilderYaml);
  updateHeaderEmptyState();
  updateBuilder();
}

function initDurationTooltips(root = document) {
  root.querySelectorAll("[data-duration-chart]").forEach((chart) => {
    const tooltip = chart.querySelector("[data-duration-tooltip]");
    chart.querySelectorAll(".duration-point").forEach((point) => {
      point.addEventListener("mouseenter", () => {
        if (tooltip) tooltip.textContent = point.dataset.tooltip || "";
      });
      point.addEventListener("focus", () => {
        if (tooltip) tooltip.textContent = point.dataset.tooltip || "";
      });
      point.addEventListener("mouseleave", () => {
        if (tooltip) tooltip.textContent = "Hover a point for exact duration.";
      });
      point.addEventListener("blur", () => {
        if (tooltip) tooltip.textContent = "Hover a point for exact duration.";
      });
    });
  });
}

function effectiveStatus(job) {
  if (!job.enabled || job.auto_disabled) return "disabled";
  if (job.failure_pause_until_utc && new Date(job.failure_pause_until_utc) > new Date()) return "paused";
  return job.last_status || "unknown";
}

function renderHeartbeat(heartbeat) {
  const el = document.getElementById("heartbeat");
  if (!heartbeat || !heartbeat.last_run_utc) {
    el.className = "heartbeat unknown";
    el.textContent = "No heartbeat yet";
    return;
  }
  const stale = minutesAgo(heartbeat.last_run_utc) > HEARTBEAT_STALE_AFTER_MINUTES;
  el.className = `heartbeat ${stale ? "stale" : heartbeat.status || "ok"}`;
  el.innerHTML = `
    <strong>${stale ? "Dispatcher stale" : "Dispatcher healthy"}</strong>
    <span class="time-secondary">${renderTime(heartbeat.last_run_utc, viewerTimeZone())}</span>
    <span class="detail">${escapeHtml(heartbeat.detail || "")}</span>
  `;
}

function renderSummary(data) {
  const total = data.meta?.total_jobs || 0;
  const failing = data.meta?.failing_jobs || 0;
  const disabled = (data.jobs || []).filter((job) => !job.enabled || job.auto_disabled).length;
  const paused = (data.jobs || []).filter((job) => effectiveStatus(job) === "paused").length;
  const successRate = data.meta?.success_rate_24h === null || data.meta?.success_rate_24h === undefined ? "-" : `${data.meta.success_rate_24h}%`;
  document.getElementById("summary").innerHTML = [
    ["Total jobs", total],
    ["Failing", failing],
    ["Paused", paused],
    ["Disabled", disabled],
    ["Runs 24h", data.meta?.executions_24h || 0],
    ["Success 24h", successRate],
    ["Avg duration", duration(data.meta?.avg_duration_ms_24h)],
  ]
    .map(([label, value]) => `
      <div class="metric">
        <div class="metric-label">${escapeHtml(label)}</div>
        <div class="metric-value">${escapeHtml(value)}</div>
      </div>
    `)
    .join("");
}

function recentRuns(data) {
  return (data.jobs || []).flatMap((job) =>
    (job.recent_history || []).map((run) => ({
      ...run,
      job_id: job.id,
      job_name: job.name || job.id,
      timezone: job.timezone,
    }))
  );
}

function runTimestamp(run) {
  const stamp = run.finished_at || run.scheduled_time;
  if (!stamp) return null;
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function renderActivityBars(runs) {
  const now = new Date();
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const start = new Date(now.getTime() - (23 - index) * 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    return { label: start.getHours().toString().padStart(2, "0"), success: 0, failed: 0, other: 0 };
  });
  const oldest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  for (const run of runs) {
    const stamp = runTimestamp(run);
    if (!stamp || stamp < oldest || run.status === "skipped") continue;
    const diffHours = Math.floor((now - stamp) / (60 * 60 * 1000));
    const bucket = buckets[23 - diffHours];
    if (!bucket) continue;
    if (run.status === "success") bucket.success += 1;
    else if (run.status === "failed") bucket.failed += 1;
    else bucket.other += 1;
  }
  const max = Math.max(1, ...buckets.map((bucket) => bucket.success + bucket.failed + bucket.other));
  return `
    <div class="activity-bars">
      ${buckets
        .map((bucket) => {
          const total = bucket.success + bucket.failed + bucket.other;
          return `
            <div class="activity-column" title="${bucket.label}:00 - ${total} run(s)">
              <div class="activity-stack" style="height: ${Math.max(4, (total / max) * 100)}%">
                <span class="bar-success" style="height: ${(bucket.success / Math.max(total, 1)) * 100}%"></span>
                <span class="bar-failed" style="height: ${(bucket.failed / Math.max(total, 1)) * 100}%"></span>
                <span class="bar-other" style="height: ${(bucket.other / Math.max(total, 1)) * 100}%"></span>
              </div>
              <span class="activity-label">${bucket.label}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderStatusMix(runs) {
  const counts = runs.reduce(
    (acc, run) => {
      acc[run.status || "unknown"] = (acc[run.status || "unknown"] || 0) + 1;
      return acc;
    },
    { success: 0, failed: 0, skipped: 0, unknown: 0 }
  );
  const total = Math.max(1, Object.values(counts).reduce((sum, value) => sum + value, 0));
  return `
    <div class="status-mix">
      ${["success", "failed", "skipped", "unknown"]
        .filter((status) => counts[status])
        .map((status) => `
          <div class="status-row">
            <span>${badge(status)}</span>
            <div class="status-track"><span class="${status}" style="width: ${(counts[status] / total) * 100}%"></span></div>
            <strong>${counts[status]}</strong>
          </div>
        `)
        .join("")}
    </div>
  `;
}

function jobStats(job) {
  const runs = (job.recent_history || []).filter((run) => run.status !== "skipped");
  const success = runs.filter((run) => run.status === "success").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const durations = runs
    .map((run) => run.duration_ms)
    .filter((value) => Number.isFinite(value));
  const avgDuration = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : null;
  const lastRun = runs
    .slice()
    .sort((a, b) => (runTimestamp(b)?.getTime() || 0) - (runTimestamp(a)?.getTime() || 0))[0];
  return {
    total: runs.length,
    success,
    failed,
    successRate: runs.length ? Math.round((success / runs.length) * 100) : null,
    avgDuration,
    lastRun,
  };
}

function renderJobStatsStrip(job) {
  const stats = jobStats(job);
  return `
    <div class="job-stats-strip">
      <div><span class="field-label">Runs</span><strong>${stats.total}</strong></div>
      <div><span class="field-label">Success</span><strong>${stats.successRate === null ? "-" : `${stats.successRate}%`}</strong></div>
      <div><span class="field-label">Failures</span><strong>${stats.failed}</strong></div>
      <div><span class="field-label">Avg duration</span><strong>${escapeHtml(duration(stats.avgDuration))}</strong></div>
    </div>
  `;
}

function renderJobDurationChart(job) {
  const runs = (job.recent_history || [])
    .filter((run) => run.status !== "skipped")
    .slice(-20);
  if (!runs.length) return `<div class="empty-state compact">No completed runs to chart yet.</div>`;
  const durations = runs.map((run) => Number.isFinite(run.duration_ms) ? Math.max(0, run.duration_ms) : 0);
  const max = Math.max(1, ...durations);
  const width = 640;
  const height = 164;
  const padX = 18;
  const padY = 18;
  const step = runs.length > 1 ? (width - padX * 2) / (runs.length - 1) : 0;
  const points = durations.map((value, index) => {
    const x = runs.length > 1 ? padX + index * step : width / 2;
    const y = height - padY - (value / max) * (height - padY * 2);
    return { x, y, value, run: runs[index] };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${path} L ${points[points.length - 1].x.toFixed(1)} ${height - padY} L ${points[0].x.toFixed(1)} ${height - padY} Z`;
  return `
    <div class="duration-line-chart" data-duration-chart>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Recent duration line chart">
        <line class="duration-grid" x1="${padX}" y1="${padY}" x2="${width - padX}" y2="${padY}"></line>
        <line class="duration-grid" x1="${padX}" y1="${height / 2}" x2="${width - padX}" y2="${height / 2}"></line>
        <line class="duration-grid" x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}"></line>
        <path class="duration-area" d="${areaPath}"></path>
        <path class="duration-line" d="${path}"></path>
        ${points
          .map((point) => `
            <circle
              class="duration-point ${escapeHtml(point.run.status || "unknown")}"
              cx="${point.x.toFixed(1)}"
              cy="${point.y.toFixed(1)}"
              r="4"
              data-tooltip="${escapeHtml(`${duration(point.run.duration_ms)} · ${point.run.status || "unknown"} · ${formatTime(point.run.finished_at || point.run.scheduled_time, job.timezone) || ""}`)}">
              <title>${escapeHtml(point.run.status || "unknown")} - ${escapeHtml(duration(point.run.duration_ms))}</title>
            </circle>
          `)
          .join("")}
      </svg>
      <div class="chart-scale">
        <span>0 ms</span>
        <span>${escapeHtml(duration(Math.round(max / 2)))}</span>
        <span>${escapeHtml(duration(max))}</span>
      </div>
      <div class="duration-tooltip" data-duration-tooltip>Hover a point for exact duration.</div>
    </div>
  `;
}

function renderJobSparks(jobs) {
  if (!jobs.length) return `<div class="empty-state">No jobs found.</div>`;
  return `
    <div class="spark-list">
      ${jobs
        .map((job) => {
          const runs = (job.recent_history || []).slice(-18);
          return `
            <div class="spark-row">
              <div>
                <strong>${escapeHtml(job.name || job.id)}</strong>
                <span class="detail">${escapeHtml(job.id)}</span>
              </div>
              <div class="spark-dots" title="Recent published history">
                ${
                  runs.length
                    ? runs
                        .map((run) => `<span class="spark-dot ${escapeHtml(run.status || "unknown")}" title="${escapeHtml(run.status || "unknown")}"></span>`)
                        .join("")
                    : `<span class="time-secondary">No history</span>`
                }
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderStatistics(data) {
  const el = document.getElementById("statistics");
  const runs = recentRuns(data);
  el.innerHTML = `
    <article class="chart-card wide">
      <div class="chart-head">
        <h2>24h Activity</h2>
        <span class="subtle">Executed runs only</span>
      </div>
      ${renderActivityBars(runs)}
    </article>
    <article class="chart-card">
      <div class="chart-head">
        <h2>Status Mix</h2>
        <span class="subtle">Recent published history</span>
      </div>
      ${renderStatusMix(runs)}
    </article>
    <article class="chart-card">
      <div class="chart-head">
        <h2>Per-Job Trend</h2>
        <span class="subtle">Newest on the right</span>
      </div>
      ${renderJobSparks(data.jobs || [])}
    </article>
  `;
}

async function copyJobToggleInstruction(job, nextEnabled) {
  const path = job.file_path || `jobs/**/${job.id}.job.yml`;
  const text = [
    `Edit ${path}`,
    "",
    `Set this field:`,
    `enabled: ${nextEnabled ? "true" : "false"}`,
    "",
    `Then run: npm run validate`,
    `Commit and push. The dispatcher will use the new state on the next run.`,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    return "Copied repo edit instructions.";
  } catch (err) {
    return text;
  }
}

function renderHistory(job, index) {
  const history = (job.recent_history || []).slice().reverse();
  if (!history.length) return `<div class="empty-state">No recent history.</div>`;
  const pageCount = Math.ceil(history.length / HISTORY_PAGE_SIZE);
  return `
    <div class="history-list" data-history-list="${index}">
      ${history
        .map((run, runIndex) => `
          <div class="history-item" data-history-page="${Math.floor(runIndex / HISTORY_PAGE_SIZE)}">
            <div>${renderTime(run.finished_at || run.scheduled_time, job.timezone)}</div>
            <div>${badge(run.status)}</div>
            <div>${escapeHtml(duration(run.duration_ms))}</div>
            <div>${escapeHtml(run.attempts ?? "-")} attempt(s)</div>
            <div>
              ${run.run_url ? `<a href="${escapeHtml(run.run_url)}" target="_blank" rel="noopener noreferrer">Workflow run</a>` : `<span class="time-secondary">No run link</span>`}
              ${run.detail ? `<span class="detail">${escapeHtml(run.detail)}</span>` : ""}
            </div>
          </div>
        `)
        .join("")}
    </div>
    ${
      pageCount > 1
        ? `<div class="history-pager" data-history-pager="${index}">
            <button type="button" class="secondary-action history-prev" data-history-target="${index}">Previous</button>
            <span class="history-page-label">Page <span data-history-current="${index}">1</span> of ${pageCount}</span>
            <button type="button" class="secondary-action history-next" data-history-target="${index}">Next</button>
          </div>`
        : ""
    }
  `;
}

function setHistoryPage(root, index, page) {
  const items = [...root.querySelectorAll(`[data-history-list="${index}"] .history-item`)];
  if (!items.length) return;
  const pageCount = Math.ceil(items.length / HISTORY_PAGE_SIZE);
  const nextPage = Math.max(0, Math.min(page, pageCount - 1));
  items.forEach((item) => {
    item.hidden = Number.parseInt(item.dataset.historyPage, 10) !== nextPage;
  });
  const label = root.querySelector(`[data-history-current="${index}"]`);
  if (label) label.textContent = String(nextPage + 1);
  const prev = root.querySelector(`.history-prev[data-history-target="${index}"]`);
  const next = root.querySelector(`.history-next[data-history-target="${index}"]`);
  if (prev) prev.disabled = nextPage === 0;
  if (next) next.disabled = nextPage >= pageCount - 1;
}

function renderJobAccordion(job, index) {
  const status = effectiveStatus(job);
  const pausedUntil = status === "paused" ? renderTime(job.failure_pause_until_utc, job.timezone) : "";
  const disabledDetail = job.auto_disabled ? job.auto_disabled_reason || "Auto-disabled after failures" : "";
  return `
    <div class="accordion-body" data-accordion-body="${index}">
      ${renderJobStatsStrip(job)}
      <div class="job-detail-grid">
        <section class="chart-card">
          <div class="chart-head">
            <h3>Duration Trend</h3>
            <span class="subtle">Recent completed runs</span>
          </div>
          ${renderJobDurationChart(job)}
        </section>
        <section class="chart-card">
          <div class="chart-head">
            <h3>Run Mix</h3>
            <span class="subtle">Recent published history</span>
          </div>
          ${renderStatusMix((job.recent_history || []).map((run) => ({ ...run, job_id: job.id })))}
        </section>
      </div>
      <div class="detail-grid">
        <div><span class="field-label">Status</span><span class="field-value">${badge(status)}${disabledDetail ? `<span class="detail">${escapeHtml(disabledDetail)}</span>` : ""}${pausedUntil ? `<span class="detail">until ${pausedUntil}</span>` : ""}</span></div>
        <div><span class="field-label">Schedule</span><span class="field-value"><code>${escapeHtml(job.schedule)}</code><span class="detail">${escapeHtml(job.timezone || "UTC")}</span></span></div>
        <div><span class="field-label">Last run</span><span class="field-value">${renderTime(job.last_evaluated_utc, job.timezone)}${triggerLabel(job.last_trigger)}</span></div>
        <div><span class="field-label">Next due</span><span class="field-value">${job.enabled && !job.auto_disabled ? renderTime(job.next_due_utc, job.timezone) : `<span class="time-secondary">Disabled</span>`}</span></div>
        <div><span class="field-label">Failure policy</span><span class="field-value">disable after ${escapeHtml(job.failure_policy?.auto_disable_after_consecutive_failures ?? 5)} failures<span class="detail">max backoff ${escapeHtml(job.failure_policy?.max_backoff_seconds ?? 21600)}s</span></span></div>
        <div><span class="field-label">History</span><span class="field-value">recent ${escapeHtml(job.recent_history?.length || 0)}<span class="detail">archives retained ${escapeHtml(job.history_retention_days || 365)} days</span></span></div>
        <div><span class="field-label">Job file</span><span class="field-value"><code>${escapeHtml(job.file_path || "Unknown job path")}</code></span></div>
      </div>
      <div class="management-panel">
        <div>
          <span class="field-label">Management</span>
          <span class="field-value">This dashboard is static. Copy the edit, update the YAML, validate, then push.</span>
        </div>
        <div class="management-actions">
          <button type="button" class="secondary-action copy-toggle" data-job-index="${index}" data-next-enabled="${job.enabled ? "false" : "true"}">
            Copy ${job.enabled ? "disable" : "enable"} edit
          </button>
          <span class="management-note" data-toggle-note="${index}"></span>
        </div>
      </div>
      <h3 class="section-title">History</h3>
      ${renderHistory(job, index)}
    </div>
  `;
}

function setJobsPage(page) {
  const jobs = filteredJobs();
  const pageCount = Math.max(1, Math.ceil(jobs.length / JOBS_PAGE_SIZE));
  jobsPage = Math.max(0, Math.min(page, pageCount - 1));
  renderJobs(dashboardData?.jobs || []);
}

function filteredJobs() {
  const jobs = dashboardData?.jobs || [];
  const query = jobFilter.trim().toLowerCase();
  if (!query) return jobs;
  return jobs.filter((job) =>
    [job.id, job.name, job.type, job.schedule, job.file_path]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query))
  );
}

function renderJobs(jobs) {
  const el = document.getElementById("jobs");
  if (!jobs.length) {
    el.innerHTML = `<div class="empty-state">No jobs found.</div>`;
    return;
  }
  const visibleJobs = filteredJobs();
  if (selectedJobId && !visibleJobs.some((job) => job.id === selectedJobId)) {
    selectedJobId = null;
  }
  const pageCount = Math.max(1, Math.ceil(visibleJobs.length / JOBS_PAGE_SIZE));
  jobsPage = Math.max(0, Math.min(jobsPage, pageCount - 1));
  const pageJobs = visibleJobs.slice(jobsPage * JOBS_PAGE_SIZE, (jobsPage + 1) * JOBS_PAGE_SIZE);
  const start = visibleJobs.length ? jobsPage * JOBS_PAGE_SIZE + 1 : 0;
  const end = Math.min(visibleJobs.length, (jobsPage + 1) * JOBS_PAGE_SIZE);
  el.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Jobs</h2>
        <p class="subtle">Filter by name or ID. Click a row to open its accordion.</p>
      </div>
      <div class="jobs-toolbar">
        <label class="filter-field">
          <span class="sr-only">Filter jobs</span>
          <input id="job-filter" value="${escapeHtml(jobFilter)}" placeholder="Filter by name, ID, path..." autocomplete="off" />
        </label>
        <button type="button" class="secondary-action" id="jobs-prev">Previous</button>
        <span class="history-page-label">${start}-${end} of ${visibleJobs.length}</span>
        <button type="button" class="secondary-action" id="jobs-next">Next</button>
      </div>
    </div>
    <div class="jobs-list">
      ${
        pageJobs.length
          ? pageJobs
    .map((job) => {
      const actualIndex = jobs.findIndex((candidate) => candidate.id === job.id);
      const status = effectiveStatus(job);
      const pausedUntil = status === "paused" ? renderTime(job.failure_pause_until_utc, job.timezone) : "";
      const disabledDetail = job.auto_disabled ? job.auto_disabled_reason || "Auto-disabled after failures" : "";
      const expanded = selectedJobId === job.id;
      const detailsId = `job-accordion-${actualIndex}`;
      return `
        <article class="job-card ${expanded ? "selected" : ""}">
          <button class="job-main job-select" type="button" data-job-index="${actualIndex}" aria-expanded="${expanded}" aria-controls="${detailsId}">
            <div>
              <h2 class="job-title">${escapeHtml(job.name || job.id)}</h2>
              <span class="job-id">${escapeHtml(job.id)}</span>
            </div>
            <div>
              <span class="field-label">Status</span>
              <span class="field-value">${badge(status)}${disabledDetail ? `<span class="detail">${escapeHtml(disabledDetail)}</span>` : ""}${pausedUntil ? `<span class="detail">until ${pausedUntil}</span>` : ""}</span>
            </div>
            <div>
              <span class="field-label">Last run</span>
              <span class="field-value">${renderTime(job.last_evaluated_utc, job.timezone)}${triggerLabel(job.last_trigger)}</span>
            </div>
            <div>
              <span class="field-label">Next due</span>
              <span class="field-value">${job.enabled && !job.auto_disabled ? renderTime(job.next_due_utc, job.timezone) : `<span class="time-secondary">Disabled</span>`}</span>
            </div>
            <div>
              <span class="field-label">Recent</span>
              ${renderJobStatsStrip(job)}
            </div>
          </button>
          <div id="${detailsId}" ${expanded ? "" : "hidden"}>
            ${expanded ? renderJobAccordion(job, actualIndex) : ""}
          </div>
        </article>
      `;
    })
    .join("")
          : `<div class="empty-state">No jobs match this filter.</div>`
      }
    </div>
  `;

  const filterInput = document.getElementById("job-filter");
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      jobFilter = filterInput.value;
      jobsPage = 0;
      renderJobs(jobs);
      const nextInput = document.getElementById("job-filter");
      nextInput?.focus();
      nextInput?.setSelectionRange(jobFilter.length, jobFilter.length);
    });
  }

  const prev = document.getElementById("jobs-prev");
  const next = document.getElementById("jobs-next");
  if (prev) {
    prev.disabled = jobsPage === 0;
    prev.addEventListener("click", () => setJobsPage(jobsPage - 1));
  }
  if (next) {
    next.disabled = jobsPage >= pageCount - 1;
    next.addEventListener("click", () => setJobsPage(jobsPage + 1));
  }

  el.querySelectorAll(".job-select").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number.parseInt(button.dataset.jobIndex, 10);
      selectedJobId = selectedJobId === jobs[index].id ? null : jobs[index].id;
      renderJobs(jobs);
    });
  });

  el.querySelectorAll(".history-prev, .history-next").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const targetIndex = button.dataset.historyTarget;
      const current = Number.parseInt(el.querySelector(`[data-history-current="${targetIndex}"]`)?.textContent || "1", 10) - 1;
      setHistoryPage(el, targetIndex, button.classList.contains("history-next") ? current + 1 : current - 1);
    });
  });

  el.querySelectorAll(".copy-toggle").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const index = Number.parseInt(button.dataset.jobIndex, 10);
      const note = el.querySelector(`[data-toggle-note="${index}"]`);
      const message = await copyJobToggleInstruction(jobs[index], button.dataset.nextEnabled === "true");
      if (note) note.textContent = message;
    });
  });

  if (selectedJobId) {
    const index = jobs.findIndex((job) => job.id === selectedJobId);
    if (index >= 0) setHistoryPage(el, String(index), 0);
    initDurationTooltips(el);
  }
}

async function main() {
  initTheme();
  initBuilder();
  document.getElementById("viewer-tz").textContent = `Browser timezone: ${viewerTimeZone()}`;
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    dashboardData = data;
    renderHeartbeat(data.heartbeat);
    renderSummary(data);
    renderStatistics(data);
    renderJobs(data.jobs || []);
    document.getElementById("generated").innerHTML = `Generated ${renderTime(data.generated_at, viewerTimeZone())}`;
  } catch (err) {
    document.getElementById("jobs").innerHTML = `
      <div class="error-state">
        Failed to load <code>${escapeHtml(DATA_URL)}</code>: ${escapeHtml(err.message || String(err))}
      </div>
    `;
  }
}

main();
