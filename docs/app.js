const DATA_URL = "dashboard-data/summary.json";
const HEARTBEAT_STALE_AFTER_MINUTES = 15; // dispatcher ticks every 5 min; 3 misses looks stale

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getViewerTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (e) {
    return null;
  }
}

// Formats an ISO-8601 UTC instant in `timeZone`, with an explicit timezone
// abbreviation baked into the text (e.g. "Aug 02, 2026, 08:31:00 UTC").
function formatInZone(isoStr, timeZone) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(d);
  } catch (e) {
    return null;
  }
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  const text = `${get("month")} ${get("day")}, ${get("year")}, ${hour}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
  return { text, abbrev: get("timeZoneName") };
}

// Renders a timestamp in the job's configured timezone, plus the viewer's
// browser-local timezone when it differs, plus a tooltip + secondary text
// carrying the raw ISO-8601 UTC instant.
function renderTimestamp(isoStr, jobTz, opts) {
  opts = opts || {};
  if (!isoStr) return `<span class="muted">—</span>`;
  const jobFmt = formatInZone(isoStr, jobTz || "UTC");
  if (!jobFmt) return `<span class="muted">invalid date</span>`;
  const tooltip = `${escapeHtml(isoStr)} (ISO 8601 UTC)`;
  let html = `<span class="tzline tzline-job" title="${tooltip}">${escapeHtml(jobFmt.text)}</span>`;

  const viewerTz = getViewerTz();
  if (viewerTz && viewerTz !== jobTz) {
    const localFmt = formatInZone(isoStr, viewerTz);
    if (localFmt) {
      html += `<br /><span class="tzline tzline-local" title="${tooltip}">${escapeHtml(localFmt.text)}</span>`;
    }
  }

  if (!opts.compact) {
    html += `<br /><small class="iso-utc" title="ISO 8601 UTC instant">${escapeHtml(isoStr)}</small>`;
  }
  return html;
}

function minutesAgo(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function statusBadge(status) {
  const s = status || "unknown";
  return `<span class="badge ${escapeHtml(s)}">${escapeHtml(s)}</span>`;
}

function triggerTag(trigger) {
  if (!trigger) return "";
  const cls = trigger === "manual" ? "manual" : "scheduled";
  return `<span class="trigger-tag ${cls}">${escapeHtml(cls)}</span>`;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function renderHeartbeat(heartbeat) {
  const el = document.getElementById("heartbeat");
  if (!heartbeat || !heartbeat.last_run_utc) {
    el.textContent = "no heartbeat yet";
    el.className = "heartbeat unknown";
    return;
  }
  const age = minutesAgo(heartbeat.last_run_utc);
  const cls = age <= HEARTBEAT_STALE_AFTER_MINUTES ? "ok" : "stale";
  el.className = `heartbeat ${cls}`;
  const viewerFmt = formatInZone(heartbeat.last_run_utc, getViewerTz() || "UTC");
  const text = viewerFmt ? viewerFmt.text : heartbeat.last_run_utc;
  const tooltip = `${escapeHtml(heartbeat.last_run_utc)} (ISO 8601 UTC)`;
  el.innerHTML = `dispatcher last ran <span title="${tooltip}">${escapeHtml(text)}</span> (${escapeHtml(heartbeat.detail || heartbeat.status || "")})`;
}

// recent_history is oldest-first, capped and pre-sanitized server-side (never
// contains response bodies/headers/secrets/raw script output) — see
// engine/history.py. We only ever render it through escapeHtml().
function renderHistoryRows(jobTz, recentHistory) {
  const HISTORY_COLS = 6;
  if (!recentHistory || !recentHistory.length) {
    return `<tr><td colspan="${HISTORY_COLS}" class="muted">No execution history yet.</td></tr>`;
  }
  return recentHistory
    .slice()
    .reverse()
    .map((run) => {
      const when = run.finished_at || run.scheduled_time;
      const runLink = run.run_url
        ? `<a href="${escapeHtml(run.run_url)}" target="_blank" rel="noopener noreferrer">View run ↗</a>`
        : `<span class="muted">—</span>`;
      const detail = run.detail ? `<div class="run-detail">${escapeHtml(run.detail)}</div>` : "";
      return `
        <tr>
          <td>${renderTimestamp(when, jobTz, { compact: true })}</td>
          <td>${statusBadge(run.status)}${detail}</td>
          <td>${fmtDuration(run.duration_ms)}</td>
          <td>${run.attempts ?? "—"}</td>
          <td>${triggerTag(run.trigger)}</td>
          <td>${runLink}</td>
        </tr>`;
    })
    .join("");
}

function renderJobs(jobs) {
  const body = document.getElementById("jobs-body");
  if (!jobs.length) {
    body.innerHTML = `<tr><td colspan="7">No jobs found.</td></tr>`;
    return;
  }
  body.innerHTML = jobs
    .map((job, idx) => {
      const status = job.enabled ? job.last_status : "disabled";
      const failing = job.consecutive_failures > 0;
      const historyId = `history-${idx}`;
      const jobTz = job.timezone || "UTC";
      return `
        <tr class="job-row" data-target="${historyId}">
          <td class="col-expand">
            <button type="button" class="expand-btn" aria-expanded="false" aria-controls="${historyId}" title="Show execution history">
              <span class="chevron">▸</span>
            </button>
          </td>
          <td><span class="job-name">${escapeHtml(job.name || job.id)}</span><span class="job-id">${escapeHtml(job.id)}</span></td>
          <td>${escapeHtml(job.type)}</td>
          <td><code>${escapeHtml(job.schedule)}</code><br /><small>${escapeHtml(jobTz)}</small></td>
          <td>${renderTimestamp(job.last_evaluated_utc, jobTz)}${job.last_trigger ? `<br />${triggerTag(job.last_trigger)}` : ""}</td>
          <td>${statusBadge(status)}${failing ? ` <small>(${job.consecutive_failures}x)</small>` : ""}${job.open_issue ? ` <small>issue #${job.open_issue}</small>` : ""}</td>
          <td>${job.enabled ? renderTimestamp(job.next_due_utc, jobTz) : `<span class="muted">—</span>`}</td>
        </tr>
        <tr class="history-row" id="${historyId}" hidden>
          <td colspan="7">
            <table class="history-table">
              <thead>
                <tr>
                  <th>Run time</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Attempts</th>
                  <th>Trigger</th>
                  <th>Workflow run</th>
                </tr>
              </thead>
              <tbody>
                ${renderHistoryRows(jobTz, job.recent_history)}
              </tbody>
            </table>
          </td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll(".expand-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = document.getElementById(btn.getAttribute("aria-controls"));
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!expanded));
      btn.querySelector(".chevron").textContent = expanded ? "▸" : "▾";
      row.hidden = expanded;
    });
  });

  body.querySelectorAll(".job-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      tr.querySelector(".expand-btn").click();
    });
  });
}

async function main() {
  const viewerTzEl = document.getElementById("viewer-tz");
  if (viewerTzEl) viewerTzEl.textContent = getViewerTz() || "unknown";

  try {
    const resp = await fetch(DATA_URL, { cache: "no-store" });
    const data = await resp.json();
    renderHeartbeat(data.heartbeat);
    renderJobs(data.jobs || []);
    const genFmt = formatInZone(data.generated_at, getViewerTz() || "UTC");
    const genText = genFmt ? genFmt.text : data.generated_at || "—";
    const genTooltip = `${escapeHtml(data.generated_at || "")} (ISO 8601 UTC)`;
    document.getElementById("meta").innerHTML =
      `${data.meta.total_jobs} job(s), ${data.meta.failing_jobs} failing — generated <span title="${genTooltip}">${escapeHtml(genText)}</span>`;
  } catch (e) {
    document.getElementById("jobs-body").innerHTML =
      `<tr><td colspan="7">Failed to load dashboard data: ${escapeHtml(String(e))}</td></tr>`;
  }
}

main();
