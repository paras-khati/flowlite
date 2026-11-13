const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.FLOWLITE_DB || path.join(__dirname, 'flowlite.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  nodes TEXT NOT NULL DEFAULT '[]',
  edges TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT DEFAULT 'manual',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS execution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT,
  node_label TEXT,
  status TEXT NOT NULL,
  input_data TEXT,
  output_data TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT
);
`);

module.exports = db;
