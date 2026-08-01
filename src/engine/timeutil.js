"use strict";

function iso(date) {
  return date.toISOString();
}

function parseIso(value) {
  return new Date(value);
}

function assertValidDate(date, label) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
}

module.exports = { iso, parseIso, assertValidDate };
