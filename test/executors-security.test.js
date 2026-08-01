"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveHeaders } = require("../src/engine/executors/http-executor");
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
