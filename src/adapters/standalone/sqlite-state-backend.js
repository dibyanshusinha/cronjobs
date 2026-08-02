"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

class SqliteStateBackend {
  static backendType = "sqlite";

  constructor(dbPath) {
    this.dbPath = dbPath;
    this.existedBeforeOpen = fs.existsSync(dbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS kv_state (
        name TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.getStmt = this.db.prepare("SELECT json FROM kv_state WHERE name = ?");
    this.saveStmt = this.db.prepare(`
      INSERT INTO kv_state(name, json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(name) DO UPDATE SET json = excluded.json, updated_at = CURRENT_TIMESTAMP
    `);
    this.listStmt = this.db.prepare("SELECT name FROM kv_state WHERE name LIKE ? ORDER BY name");
    this.deleteStmt = this.db.prepare("DELETE FROM kv_state WHERE name = ?");
  }

  load(name, defaultValue) {
    const row = this.getStmt.get(name);
    if (!row) return structuredClone(defaultValue);
    return JSON.parse(row.json);
  }

  save(name, data) {
    this.saveStmt.run(name, JSON.stringify(data));
  }

  list(prefix) {
    return this.listStmt.all(`${prefix}/%`).map((row) => row.name);
  }

  delete(name) {
    this.deleteStmt.run(name);
  }

  close() {
    this.db.close();
  }

  exportToDirectory(targetDir) {
    if (!this.existedBeforeOpen) return false;
    return copyIfExists(this.dbPath, path.join(targetDir, path.basename(this.dbPath)));
  }

  restoreFromDirectory(sourceDir) {
    return copyIfExists(path.join(sourceDir, path.basename(this.dbPath)), this.dbPath);
  }
}

module.exports = { SqliteStateBackend };
