"use strict";

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config");
const { createStateBackend } = require("./state-backend-factory");

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: false });
  return true;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backup(targetDir = process.env.BACKUP_DIR) {
  const config = loadConfig();
  const root = path.resolve(targetDir || path.join(config.dataDir, "backups", timestamp()));
  const backend = createStateBackend(config);
  fs.mkdirSync(root, { recursive: true });
  try {
    const manifest = {
      created_at: new Date().toISOString(),
      state_backend: config.stateBackend,
      copied: {
        jobs: copyIfExists(config.jobsDir, path.join(root, "jobs")),
        scripts: copyIfExists(path.join(config.scriptsRoot, "scripts"), path.join(root, "scripts")),
        state: backend.exportToDirectory ? backend.exportToDirectory(path.join(root, "data")) : false,
      },
    };
    fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { root, manifest };
  } finally {
    backend.close?.();
  }
}

function restore(sourceDir = process.env.RESTORE_DIR) {
  if (!sourceDir) throw new Error("RESTORE_DIR or first argument is required");
  const config = loadConfig();
  const backend = createStateBackend(config);
  const root = path.resolve(sourceDir);
  let closed = false;
  try {
    if (!fs.existsSync(root)) throw new Error(`backup directory does not exist: ${root}`);
    backend.close?.();
    closed = true;
    const copied = {
      jobs: copyIfExists(path.join(root, "jobs"), config.jobsDir),
      scripts: copyIfExists(path.join(root, "scripts"), path.join(config.scriptsRoot, "scripts")),
      state: backend.restoreFromDirectory ? backend.restoreFromDirectory(path.join(root, "data")) : false,
    };
    return { root, copied };
  } finally {
    if (!closed) backend.close?.();
  }
}

function main() {
  const command = process.argv[2] || "backup";
  const dir = process.argv[3];
  if (command === "backup") {
    const result = backup(dir);
    console.log(`Backup written to ${result.root}`);
    return 0;
  }
  if (command === "restore") {
    const result = restore(dir);
    console.log(`Restore completed from ${result.root}`);
    return 0;
  }
  console.error("Usage: node src/adapters/standalone/backup.js [backup [target_dir] | restore source_dir]");
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err.message || String(err));
    process.exitCode = 1;
  }
}

module.exports = { backup, restore };
