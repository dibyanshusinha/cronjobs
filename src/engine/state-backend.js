"use strict";

const fs = require("fs");
const path = require("path");

/**
 * StateBackend contract.
 *
 * A state backend stores JSON-serializable documents addressed by logical names
 * such as "state/cursors" or "history/job-a". Core engine modules depend only
 * on this contract, not on files, SQLite, GitHub, or any future database.
 *
 * Required methods:
 * - load(name, defaultValue): return the stored JSON value, or a clone of
 *   defaultValue when no value exists.
 * - save(name, data): persist a JSON-serializable value at name.
 * - list(prefix): return stored logical names below prefix, without extensions.
 * - delete(name): remove the value at name if it exists.
 *
 * Optional lifecycle/capability methods:
 * - close(): release resources held by the backend.
 * - exportToDirectory(targetDir): copy/export backend-owned durable state into
 *   targetDir for backup.
 * - restoreFromDirectory(sourceDir): restore backend-owned durable state from
 *   sourceDir.
 */
const STATE_BACKEND_REQUIRED_METHODS = ["load", "save", "list", "delete"];

function assertStateBackend(backend, label = "state backend") {
  for (const method of STATE_BACKEND_REQUIRED_METHODS) {
    if (!backend || typeof backend[method] !== "function") {
      throw new TypeError(`${label} must implement ${method}()`);
    }
  }
  return backend;
}

class JsonFileStateBackend {
  static backendType = "json-file";

  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  pathFor(name) {
    return path.join(this.baseDir, `${name}.json`);
  }

  load(name, defaultValue) {
    const filePath = this.pathFor(name);
    if (!fs.existsSync(filePath)) return structuredClone(defaultValue);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  save(name, data) {
    const filePath = this.pathFor(name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmpPath, filePath);
  }

  list(prefix) {
    const root = path.join(this.baseDir, prefix);
    if (!fs.existsSync(root)) return [];
    const names = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          names.push(path.relative(this.baseDir, entryPath).replace(/\.json$/, ""));
        }
      }
    };
    walk(root);
    return names.sort();
  }

  delete(name) {
    const filePath = this.pathFor(name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  close() {}
}

module.exports = { JsonFileStateBackend, STATE_BACKEND_REQUIRED_METHODS, assertStateBackend };
