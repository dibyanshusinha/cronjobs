"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { JsonFileStateBackend, assertStateBackend } = require("../src/engine/state-backend");
const { SqliteStateBackend } = require("../src/adapters/standalone/sqlite-state-backend");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-state-backend-"));
}

const backendCases = [
  {
    name: "JsonFileStateBackend",
    create() {
      return new JsonFileStateBackend(tempRoot());
    },
  },
  {
    name: "SqliteStateBackend",
    create() {
      return new SqliteStateBackend(path.join(tempRoot(), "state.sqlite"));
    },
  },
];

for (const backendCase of backendCases) {
  test(`${backendCase.name} implements StateBackend load/save/list/delete`, () => {
    const backend = assertStateBackend(backendCase.create(), backendCase.name);
    try {
      const fallback = { nested: { ok: true }, items: [] };
      const loadedFallback = backend.load("state/missing", fallback);
      loadedFallback.items.push("changed");
      assert.deepEqual(fallback, { nested: { ok: true }, items: [] });

      backend.save("state/example", { ok: true, count: 2 });
      backend.save("state/nested/other", { ok: false });
      backend.save("history/job-a", { runs: [] });

      assert.deepEqual(backend.load("state/example", {}), { ok: true, count: 2 });
      assert.deepEqual(backend.list("state"), ["state/example", "state/nested/other"]);
      assert.deepEqual(backend.list("missing"), []);

      backend.delete("state/example");
      assert.deepEqual(backend.load("state/example", { deleted: true }), { deleted: true });
      assert.deepEqual(backend.list("state"), ["state/nested/other"]);
    } finally {
      backend.close?.();
    }
  });
}

test("assertStateBackend rejects missing required methods", () => {
  assert.throws(() => assertStateBackend({ load() {} }, "broken backend"), /save\(\)/);
});
