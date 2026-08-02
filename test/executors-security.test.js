"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { HistoryStore } = require("../src/engine/history");
const { JsonFileStateBackend } = require("../src/engine/state-backend");
const { execute: executeHttp, MAX_RESPONSE_BYTES, resolveHeaders } = require("../src/engine/executors/http-executor");
const {
  ScriptSecurityError,
  resolveInterpreter,
  resolveScriptPath,
} = require("../src/engine/executors/script-executor");

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-repo-"));
  fs.mkdirSync(path.join(repo, "scripts", "examples"), { recursive: true });
  fs.writeFileSync(path.join(repo, "scripts", "examples", "ok.sh"), "#!/bin/sh\necho hi\n");
  return repo;
}

test("resolveScriptPath happy case", () => {
  const repo = makeRepo();
  assert.equal(
    resolveScriptPath(repo, "scripts/examples/ok.sh"),
    fs.realpathSync(path.join(repo, "scripts", "examples", "ok.sh"))
  );
});

test("resolveScriptPath rejects leading slash", () => {
  const repo = makeRepo();
  assert.throws(() => resolveScriptPath(repo, "/etc/passwd"), ScriptSecurityError);
});

test("resolveScriptPath rejects dotdot traversal", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "secret.sh"), "echo leaked");
  assert.throws(() => resolveScriptPath(repo, "scripts/../secret.sh"), ScriptSecurityError);
});

test("resolveScriptPath rejects outside scripts dir", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "notscripts"));
  fs.writeFileSync(path.join(repo, "notscripts", "x.sh"), "echo hi");
  assert.throws(() => resolveScriptPath(repo, "notscripts/x.sh"), ScriptSecurityError);
});

test("resolveScriptPath rejects missing file", () => {
  const repo = makeRepo();
  assert.throws(() => resolveScriptPath(repo, "scripts/examples/does-not-exist.sh"), ScriptSecurityError);
});

test("resolveScriptPath rejects symlink escape", () => {
  const repo = makeRepo();
  const outside = path.join(os.tmpdir(), `outside-target-${Date.now()}.sh`);
  fs.writeFileSync(outside, "echo escaped");
  const link = path.join(repo, "scripts", "examples", "escape.sh");
  try {
    fs.symlinkSync(outside, link);
  } catch (err) {
    return;
  }
  assert.throws(() => resolveScriptPath(repo, "scripts/examples/escape.sh"), ScriptSecurityError);
});

test("resolveInterpreter from extension", () => {
  assert.equal(resolveInterpreter({ path: "scripts/examples/ok.sh" }), "bash");
});

test("resolveInterpreter explicit wins", () => {
  assert.equal(resolveInterpreter({ path: "scripts/examples/ok.sh", interpreter: "python3" }), "python3");
});

test("resolveInterpreter rejects unknown", () => {
  assert.throws(() => resolveInterpreter({ path: "scripts/examples/ok.custom", interpreter: "perl" }), ScriptSecurityError);
});

test("resolveHeaders substitutes env var", () => {
  process.env.MY_TOKEN = "s3cr3t";
  assert.deepEqual(resolveHeaders({ Authorization: "${MY_TOKEN}", "X-Plain": "unchanged" }), {
    Authorization: "s3cr3t",
    "X-Plain": "unchanged",
  });
});

test("resolveHeaders missing env var becomes empty", () => {
  delete process.env.UNSET_VAR;
  assert.deepEqual(resolveHeaders({ Authorization: "${UNSET_VAR}" }), { Authorization: "" });
});

function httpServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverUrl(server, pathName = "/") {
  return `http://127.0.0.1:${server.address().port}${pathName}`;
}

test("http executor does not follow redirects", async () => {
  const server = await httpServer((req, res) => {
    res.writeHead(302, { Location: "/target" });
    res.end("redirect");
  });
  try {
    const result = await executeHttp("job", "2026-08-02T00:00:00.000Z", {
      method: "GET",
      url: serverUrl(server),
      headers: {},
      expected_status: [200],
      timeout_seconds: 5,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /HTTP 302/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("http executor caps oversized response reads", async () => {
  const tail = "needle-after-limit";
  const server = await httpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`${"x".repeat(MAX_RESPONSE_BYTES + 1024)}${tail}`);
  });
  try {
    const result = await executeHttp("job", "2026-08-02T00:00:00.000Z", {
      method: "GET",
      url: serverUrl(server),
      headers: {},
      expected_status: [200],
      timeout_seconds: 5,
      validate_contains: tail,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /validate_contains not found/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("history redacts sensitive output before persistence", () => {
  const repo = makeRepo();
  const oldSecret = process.env.API_TOKEN;
  process.env.API_TOKEN = "super-secret-value";
  try {
    const backend = new JsonFileStateBackend(path.join(repo, "state"));
    const history = new HistoryStore(backend);
    history.append(
      "job-a",
      {
        job_id: "job-a",
        scheduled_time: "2026-08-02T00:00:00.000Z",
        status: "failed",
        started_at: "2026-08-02T00:00:00.000Z",
        finished_at: "2026-08-02T00:00:01.000Z",
        duration_ms: 1000,
        attempts: 1,
        detail: "script printed super-secret-value",
        trigger: "scheduled",
        run_url: null,
      },
      10
    );
    const data = backend.load("history/job-a", { runs: [] });
    assert.equal(data.runs[0].detail.includes("super-secret-value"), false);
    assert.equal(data.runs[0].detail.includes("[redacted]"), true);
  } finally {
    if (oldSecret === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = oldSecret;
  }
});
