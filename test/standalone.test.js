"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { SqliteStateBackend } = require("../src/adapters/standalone/sqlite-state-backend");
const { StandaloneRuntime } = require("../src/adapters/standalone/runtime");
const { createStateBackend } = require("../src/adapters/standalone/state-backend-factory");
const { createServer } = require("../src/adapters/standalone/server");
const backupCli = require("../src/adapters/standalone/backup");

const TEST_PASSWORD = ["test", "pass"].join("-");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cronjobs-standalone-"));
}

function writeStandaloneFixture(root) {
  fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts", "examples"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "jobs", "script.job.yml"),
    [
      "id: standalone-script",
      "name: Standalone script",
      "schedule: '*/5 * * * *'",
      "timezone: UTC",
      "type: script",
      "retries: 0",
      "script:",
      "  path: scripts/examples/ok.sh",
      "  interpreter: bash",
      "  timeout_seconds: 5",
      "",
    ].join("\n")
  );
  fs.writeFileSync(path.join(root, "scripts", "examples", "ok.sh"), "#!/usr/bin/env bash\nexit 0\n");
  fs.chmodSync(path.join(root, "scripts", "examples", "ok.sh"), 0o755);
}

function writeCountingFixture(root) {
  fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts", "examples"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "jobs", "count.job.yml"),
    [
      "id: due-counter",
      "name: Due counter",
      "schedule: '1 5 2 8 *'",
      "timezone: UTC",
      "type: script",
      "enabled: true",
      "retries: 0",
      "script:",
      "  path: scripts/examples/count.sh",
      "  interpreter: bash",
      "  args:",
      `    - "${path.join(root, "counter.txt")}"`,
      "  timeout_seconds: 5",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(root, "scripts", "examples", "count.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\ncount_file=\"$1\"\nif [ -f \"$count_file\" ]; then count=$(cat \"$count_file\"); else count=0; fi\nprintf '%s' \"$((count + 1))\" > \"$count_file\"\n"
  );
  fs.chmodSync(path.join(root, "scripts", "examples", "count.sh"), 0o755);
}

function configFor(root, extra = {}) {
  return {
    repoRoot: root,
    dataDir: path.join(root, "data"),
    dbPath: path.join(root, "data", "cronjobs.sqlite"),
    jobsDir: path.join(root, "jobs"),
    scriptsRoot: root,
    host: "127.0.0.1",
    port: 0,
    pollSeconds: 60,
    maxConcurrency: 1,
    dashboardUser: "admin",
    dashboardPassword: TEST_PASSWORD,
    dashboardToken: "",
    allowNoAuth: false,
    webhookUrl: "",
    ...extra,
  };
}

function request(server, options = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: options.path || "/",
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("SqliteStateBackend persists JSON state", () => {
  const root = tempRoot();
  const dbPath = path.join(root, "state.sqlite");
  const backend = new SqliteStateBackend(dbPath);
  backend.save("state/example", { ok: true, count: 2 });
  backend.close();

  const reopened = new SqliteStateBackend(dbPath);
  assert.deepEqual(reopened.load("state/example", {}), { ok: true, count: 2 });
  assert.deepEqual(reopened.list("state"), ["state/example"]);
  reopened.close();
});

test("standalone state backend factory selects SQLite and rejects unsupported backends", () => {
  const root = tempRoot();
  const sqlite = createStateBackend(configFor(root));
  try {
    assert.equal(sqlite.constructor.backendType, "sqlite");
  } finally {
    sqlite.close();
  }
  assert.throws(() => createStateBackend(configFor(root, { stateBackend: "postgres" })), /unsupported/);
});

test("standalone runtime manually executes a script job without GitHub environment", async () => {
  const oldGithubToken = process.env.GITHUB_TOKEN;
  const oldGithubRepo = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;

  const root = tempRoot();
  writeStandaloneFixture(root);
  const runtime = new StandaloneRuntime(configFor(root));
  try {
    const result = await runtime.tick({ jobId: "standalone-script", forceDisabled: false });
    assert.equal(result.ran.length, 1);
    assert.equal(result.ran[0].status, "success");
    const summary = runtime.summary();
    assert.equal(summary.jobs.length, 1);
    assert.equal(summary.jobs[0].id, "standalone-script");
    assert.equal(summary.jobs[0].last_status, "success");
  } finally {
    runtime.stop();
    if (oldGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldGithubToken;
    if (oldGithubRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = oldGithubRepo;
  }
});

test("standalone web server authenticates dashboard data", async () => {
  const root = tempRoot();
  writeStandaloneFixture(root);
  const runtime = new StandaloneRuntime(configFor(root));
  const server = createServer(runtime, runtime.config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const unauth = await request(server, { path: "/dashboard-data/summary.json" });
    assert.equal(unauth.statusCode, 401);

    const auth = Buffer.from(`admin:${TEST_PASSWORD}`).toString("base64");
    const authed = await request(server, {
      path: "/dashboard-data/summary.json",
      headers: { Authorization: `Basic ${auth}` },
    });
    assert.equal(authed.statusCode, 200);
    assert.equal(JSON.parse(authed.body).jobs[0].id, "standalone-script");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.stop();
  }
});

test("standalone web server rejects missing and invalid credentials and accepts Basic and Bearer", async () => {
  const root = tempRoot();
  writeStandaloneFixture(root);
  const runtime = new StandaloneRuntime(configFor(root, { dashboardToken: "bearer-token" }));
  const server = createServer(runtime, runtime.config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const missing = await request(server, { path: "/api/jobs" });
    assert.equal(missing.statusCode, 401);

    const invalidBasic = Buffer.from("admin:wrong").toString("base64");
    const badBasic = await request(server, {
      path: "/api/jobs",
      headers: { Authorization: `Basic ${invalidBasic}` },
    });
    assert.equal(badBasic.statusCode, 401);

    const badBearer = await request(server, {
      path: "/api/jobs",
      headers: { Authorization: "Bearer wrong" },
    });
    assert.equal(badBearer.statusCode, 401);

    const validBasic = Buffer.from(`admin:${TEST_PASSWORD}`).toString("base64");
    const goodBasic = await request(server, {
      path: "/api/jobs",
      headers: { Authorization: `Basic ${validBasic}` },
    });
    assert.equal(goodBasic.statusCode, 200);

    const goodBearer = await request(server, {
      path: "/api/jobs",
      headers: { Authorization: "Bearer bearer-token" },
    });
    assert.equal(goodBearer.statusCode, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.stop();
  }
});

test("standalone scheduled tick runs a due job once and persists SQLite state", async () => {
  const root = tempRoot();
  writeCountingFixture(root);
  const config = configFor(root);
  const runtime = new StandaloneRuntime(config);
  try {
    const now = new Date("2026-08-02T05:01:00.000Z");
    const result = await runtime.tick({ now });
    assert.equal(result.ran.length, 1);
    assert.equal(result.ran[0].status, "success");
    assert.equal(fs.readFileSync(path.join(root, "counter.txt"), "utf8"), "1");
  } finally {
    runtime.stop();
  }

  const reopened = new SqliteStateBackend(config.dbPath);
  try {
    const history = reopened.load("history/due-counter", { runs: [] });
    assert.equal(history.runs.length, 1);
    assert.equal(history.runs[0].status, "success");
    assert.equal(reopened.load("state/dedup", {}).executed["due-counter|2026-08-02T05:01:00.000Z"].status, "success");
  } finally {
    reopened.close();
  }
});

test("standalone restart does not duplicate an already finalized occurrence", async () => {
  const root = tempRoot();
  writeCountingFixture(root);
  const config = configFor(root);
  const now = new Date("2026-08-02T05:01:00.000Z");

  const first = new StandaloneRuntime(config);
  try {
    const result = await first.tick({ now });
    assert.equal(result.ran.length, 1);
  } finally {
    first.stop();
  }

  const restarted = new StandaloneRuntime(config);
  try {
    const result = await restarted.tick({ now });
    assert.equal(result.ran.length, 0);
    assert.equal(fs.readFileSync(path.join(root, "counter.txt"), "utf8"), "1");
  } finally {
    restarted.stop();
  }
});

test("backup and restore copy jobs, scripts, and SQLite data", () => {
  const root = tempRoot();
  writeStandaloneFixture(root);
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const sourceBackend = new SqliteStateBackend(path.join(root, "data", "cronjobs.sqlite"));
  sourceBackend.save("state/example", { restored: true });
  sourceBackend.close();
  const backupDir = path.join(root, "backup");
  const restoreRoot = tempRoot();

  const oldEnv = { ...process.env };
  try {
    process.env.DATA_DIR = path.join(root, "data");
    process.env.SQLITE_PATH = path.join(root, "data", "cronjobs.sqlite");
    process.env.JOBS_DIR = path.join(root, "jobs");
    process.env.SCRIPTS_ROOT = root;
    backupCli.backup(backupDir);

    process.env.DATA_DIR = path.join(restoreRoot, "data");
    process.env.SQLITE_PATH = path.join(restoreRoot, "data", "cronjobs.sqlite");
    process.env.JOBS_DIR = path.join(restoreRoot, "jobs");
    process.env.SCRIPTS_ROOT = restoreRoot;
    backupCli.restore(backupDir);

    assert.equal(fs.existsSync(path.join(restoreRoot, "jobs", "script.job.yml")), true);
    assert.equal(fs.existsSync(path.join(restoreRoot, "scripts", "examples", "ok.sh")), true);
    const restoredBackend = new SqliteStateBackend(path.join(restoreRoot, "data", "cronjobs.sqlite"));
    try {
      assert.deepEqual(restoredBackend.load("state/example", {}), { restored: true });
    } finally {
      restoredBackend.close();
    }
  } finally {
    process.env = oldEnv;
  }
});
