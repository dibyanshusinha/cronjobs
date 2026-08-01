"use strict";

const fs = require("fs");
const path = require("path");

class JsonFileStateBackend {
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
}

module.exports = { JsonFileStateBackend };
