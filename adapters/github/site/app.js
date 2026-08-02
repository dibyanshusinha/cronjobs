const DATA_URL = "dashboard-data/summary.json";
const HEARTBEAT_STALE_AFTER_MINUTES = 15;
const THEME_KEY = "cronjobs-theme";

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
    document.querySelector('[name="schedule"]').value = data.preset;
    data.schedule = data.preset;
  }
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
  document.getElementById("summary").innerHTML = [
    ["Total jobs", total],
    ["Failing", failing],
    ["Paused", paused],
    ["Disabled", disabled],
  ]
    .map(([label, value]) => `
      <div class="metric">
        <div class="metric-label">${escapeHtml(label)}</div>
        <div class="metric-value">${escapeHtml(value)}</div>
      </div>
    `)
    .join("");
}

function renderHistory(job) {
  const history = (job.recent_history || []).slice().reverse();
  if (!history.length) return `<div class="empty-state">No recent history.</div>`;
  return `
    <div class="history-list">
      ${history
        .map((run) => `
          <div class="history-item">
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
  `;
}

function renderJobs(jobs) {
  const el = document.getElementById("jobs");
  if (!jobs.length) {
    el.innerHTML = `<div class="empty-state">No jobs found.</div>`;
    return;
  }
  el.innerHTML = jobs
    .map((job, index) => {
      const status = effectiveStatus(job);
      const detailsId = `job-details-${index}`;
      const pausedUntil = status === "paused" ? renderTime(job.failure_pause_until_utc, job.timezone) : "";
      const disabledDetail = job.auto_disabled ? job.auto_disabled_reason || "Auto-disabled after failures" : "";
      return `
        <article class="job-card">
          <div class="job-main">
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
            <div class="actions">
              <button class="toggle" type="button" aria-expanded="false" aria-controls="${detailsId}" title="Show recent history">+</button>
            </div>
          </div>
          <div id="${detailsId}" class="details" hidden>
            <div class="detail-grid">
              <div><span class="field-label">Schedule</span><span class="field-value"><code>${escapeHtml(job.schedule)}</code><span class="detail">${escapeHtml(job.timezone || "UTC")}</span></span></div>
              <div><span class="field-label">Failure policy</span><span class="field-value">disable after ${escapeHtml(job.failure_policy?.auto_disable_after_consecutive_failures ?? 5)} failures<span class="detail">max backoff ${escapeHtml(job.failure_policy?.max_backoff_seconds ?? 21600)}s</span></span></div>
              <div><span class="field-label">History</span><span class="field-value">showing recent ${escapeHtml(job.recent_history?.length || 0)}<span class="detail">archives retained ${escapeHtml(job.history_retention_days || 365)} days</span></span></div>
            </div>
            ${renderHistory(job)}
          </div>
        </article>
      `;
    })
    .join("");

  el.querySelectorAll(".toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.getElementById(button.getAttribute("aria-controls"));
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.textContent = expanded ? "+" : "-";
      target.hidden = expanded;
    });
  });
}

async function main() {
  initTheme();
  initBuilder();
  document.getElementById("viewer-tz").textContent = `Browser timezone: ${viewerTimeZone()}`;
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    renderHeartbeat(data.heartbeat);
    renderSummary(data);
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
