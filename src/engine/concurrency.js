"use strict";

async function runBounded(tasks, maxWorkers = 5) {
  if (!tasks.length) return [];
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const idx = next;
      next += 1;
      results[idx] = await tasks[idx]();
    }
  }
  const count = Math.max(1, Math.min(maxWorkers, tasks.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

module.exports = { runBounded };
