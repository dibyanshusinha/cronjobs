const DATA_URL = "dashboard-data/summary.json";
const HEARTBEAT_STALE_AFTER_MINUTES = 15; // dispatcher ticks every 5 min; 3 misses looks stale

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { hour12: false });
}

function minutesAgo(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function statusBadge(status) {
  const s = status || "unknown";
  return `<span class="badge ${s}">${s}</span>`;
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
  el.textContent = `dispatcher last ran ${fmtTime(heartbeat.last_run_utc)} (${heartbeat.detail || heartbeat.status})`;
}

function renderJobs(jobs) {
  const body = document.getElementById("jobs-body");
  if (!jobs.length) {
    body.innerHTML = `<tr><td colspan="6">No jobs found.</td></tr>`;
    return;
  }
  body.innerHTML = jobs
    .map((job) => {
      const status = job.enabled ? job.last_status : "disabled";
      const failing = job.consecutive_failures > 0;
      return `
        <tr>
          <td><span class="job-name">${job.name || job.id}</span><span class="job-id">${job.id}</span></td>
          <td>${job.type}</td>
          <td><code>${job.schedule}</code><br /><small>${job.timezone}</small></td>
          <td>${fmtTime(job.last_evaluated_utc)}</td>
          <td>${statusBadge(status)}${failing ? ` <small>(${job.consecutive_failures}x)</small>` : ""}${job.open_issue ? ` <small>issue #${job.open_issue}</small>` : ""}</td>
          <td>${job.enabled ? fmtTime(job.next_due_utc) : "—"}</td>
        </tr>`;
    })
    .join("");
}

async function main() {
  try {
    const resp = await fetch(DATA_URL, { cache: "no-store" });
    const data = await resp.json();
    renderHeartbeat(data.heartbeat);
    renderJobs(data.jobs || []);
    document.getElementById("meta").textContent =
      `${data.meta.total_jobs} job(s), ${data.meta.failing_jobs} failing — generated ${fmtTime(data.generated_at)}`;
  } catch (e) {
    document.getElementById("jobs-body").innerHTML =
      `<tr><td colspan="6">Failed to load dashboard data: ${e}</td></tr>`;
  }
}

main();
