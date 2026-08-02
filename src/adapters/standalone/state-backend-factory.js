"use strict";

const { assertStateBackend } = require("../../engine/state-backend");
const { SqliteStateBackend } = require("./sqlite-state-backend");

const STANDALONE_BACKENDS = {
  sqlite: (config) => new SqliteStateBackend(config.dbPath),
};

function createStateBackend(config) {
  const type = config.stateBackend || "sqlite";
  const factory = STANDALONE_BACKENDS[type];
  if (!factory) {
    throw new Error(`unsupported standalone state backend '${type}'`);
  }
  return assertStateBackend(factory(config), `${type} state backend`);
}

module.exports = { createStateBackend, STANDALONE_BACKENDS };
