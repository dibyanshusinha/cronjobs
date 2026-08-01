"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ALLOWED_INTERPRETERS = {
  bash: "bash",
  python3: "python3",
  node: "node",
};
const EXTENSION_INTERPRETER = {
  ".sh": "bash",
  ".py": "python3",
  ".js": "node",
};

class ScriptSecurityError extends Error {}

function hasDotDot(rawPath) {
  return rawPath.split(/[\\/]+/).includes("..");
}

function resolveScriptPath(repoRoot, rawPath) {
  if (path.isAbsolute(rawPath) || hasDotDot(rawPath)) {
    throw new ScriptSecurityError(
      `script path '${rawPath}' must be relative, under scripts/, with no '..' segment`
    );
  }
  const repoRootResolved = fs.realpathSync(repoRoot);
  const scriptsRootResolved = fs.realpathSync(path.join(repoRootResolved, "scripts"));
  const candidate = path.resolve(repoRootResolved, rawPath);
  const rel = path.relative(scriptsRootResolved, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ScriptSecurityError(`script path '${rawPath}' must be under scripts/`);
  }

  let walked = repoRootResolved;
  for (const part of rawPath.split(/[\\/]+/)) {
    walked = path.join(walked, part);
    if (fs.existsSync(walked) && fs.lstatSync(walked).isSymbolicLink()) {
      throw new ScriptSecurityError(`script path '${rawPath}' contains a symlink - not allowed`);
    }
  }

  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch (err) {
    throw new ScriptSecurityError(`script '${rawPath}' does not exist or is not a regular file`);
  }
  if (!stat.isFile()) {
    throw new ScriptSecurityError(`script '${rawPath}' does not exist or is not a regular file`);
  }
  return fs.realpathSync(candidate);
}

function resolveInterpreter(spec) {
  let interpreter = spec.interpreter;
  if (!interpreter) interpreter = EXTENSION_INTERPRETER[path.extname(spec.path)];
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_INTERPRETERS, interpreter)) {
    throw new ScriptSecurityError(`interpreter '${interpreter}' is not in the allowlist`);
  }
  return interpreter;
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: err });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

async function execute(jobId, spec, repoRoot) {
  let scriptPath;
  let interpreter;
  try {
    scriptPath = resolveScriptPath(repoRoot, spec.path);
    interpreter = resolveInterpreter(spec);
  } catch (err) {
    if (err instanceof ScriptSecurityError) return { ok: false, detail: `blocked: ${err.message}` };
    throw err;
  }

  const result = await runProcess(
    ALLOWED_INTERPRETERS[interpreter],
    [scriptPath, ...(spec.args || [])],
    spec.timeout_seconds * 1000
  );
  if (result.timedOut) return { ok: false, detail: `timed out after ${spec.timeout_seconds}s` };
  if (result.error) return { ok: false, detail: `launch error: ${result.error.name || "Error"}` };
  return { ok: result.code === 0, detail: `exit code ${result.code}` };
}

module.exports = {
  ALLOWED_INTERPRETERS,
  ScriptSecurityError,
  resolveScriptPath,
  resolveInterpreter,
  execute,
};
