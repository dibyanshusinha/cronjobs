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
