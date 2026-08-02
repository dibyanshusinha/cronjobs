"use strict";

class StandaloneNotifier {
  constructor(options = {}) {
    this.webhookUrl = options.webhookUrl || "";
    this.events = [];
  }

  async send(event) {
    const entry = { ...event, emitted_at: new Date().toISOString() };
    this.events.push(entry);
    if (!this.webhookUrl) {
      console.warn(`[notify:${event.type}] ${event.job_id}: ${event.message}`);
      return;
    }
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
    } catch (err) {
      console.warn(`notification webhook failed: ${err.message || String(err)}`);
    }
  }

  async notifyFailure(job, result, consecutiveFailures) {
    await this.send({
      type: "failure",
      job_id: job.id,
      job_name: job.name,
      status: result.status,
      consecutive_failures: consecutiveFailures,
      message: result.detail || "job failed",
      scheduled_time: result.scheduled_time,
    });
  }

  async notifyRecovery(job, result) {
    await this.send({
      type: "recovery",
      job_id: job.id,
      job_name: job.name,
      status: result.status,
      message: "job recovered",
      scheduled_time: result.scheduled_time,
    });
  }
}

module.exports = { StandaloneNotifier };
