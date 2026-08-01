"use strict";

const parser = require("cron-parser");

const MAX_OCCURRENCES_PER_CALL = 2000;

function computeDueOccurrences(schedule, timezone, since, now) {
  if (!(since instanceof Date) || Number.isNaN(since.getTime()) || !(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("since/now must be timezone-aware valid Date values");
  }
  const interval = parser.parseExpression(schedule, {
    currentDate: since,
    endDate: now,
    tz: timezone,
  });
  const occurrences = [];
  for (let i = 0; i < MAX_OCCURRENCES_PER_CALL; i += 1) {
    try {
      occurrences.push(interval.next().toDate());
    } catch (err) {
      if (err.message && err.message.includes("Out of the timespan range")) break;
      throw err;
    }
  }
  if (occurrences.length === MAX_OCCURRENCES_PER_CALL) {
    throw new Error(
      `schedule '${schedule}' produced more than ${MAX_OCCURRENCES_PER_CALL} occurrences in one window`
    );
  }
  return occurrences;
}

function applyMisfirePolicy(occurrences, policy, cap) {
  if (!occurrences.length) return [[], []];
  if (policy === "most_recent") return [[occurrences[occurrences.length - 1]], occurrences.slice(0, -1)];
  if (policy === "all") {
    if (occurrences.length <= cap) return [occurrences.slice(), []];
    return [occurrences.slice(-cap), occurrences.slice(0, -cap)];
  }
  throw new Error(`unknown misfire policy '${policy}'`);
}

function nextDueAfter(schedule, timezone, after) {
  return parser.parseExpression(schedule, { currentDate: after, tz: timezone }).next().toDate();
}

module.exports = {
  MAX_OCCURRENCES_PER_CALL,
  computeDueOccurrences,
  applyMisfirePolicy,
  nextDueAfter,
};
