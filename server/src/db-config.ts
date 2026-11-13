import { db } from './db.js';

/**
 * Schema additions for bot settings, memory over time and hibernation.
 * Kept out of db.ts on purpose: everything here is idempotent (CREATE IF NOT EXISTS
 * and ALTERs guarded by a column check), so it is safe on old and new databases.
 */

function hasColumn(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);
}

function addColumn(table: string, col: string, ddl: string) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

addColumn('skills', 'description', "TEXT NOT NULL DEFAULT ''");
addColumn('skills', 'updated_at', 'INTEGER');
/** 'chat' = saved by the bot's remember tool, 'learned' = extracted by consolidation. */
addColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'chat'");
addColumn('memories', 'status', "TEXT NOT NULL DEFAULT 'active'");
addColumn('memories', 'kind', "TEXT NOT NULL DEFAULT 'durable'");
addColumn('memories', 'expires_at', 'INTEGER');
addColumn('memories', 'superseded_by', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS memory_usage (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  input_items INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  overhead_chars INTEGER NOT NULL,
  model TEXT NOT NULL,
  prefix_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_jobs (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  last_consolidated_at INTEGER NOT NULL DEFAULT 0,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  method TEXT NOT NULL,
  items_before INTEGER NOT NULL,
  items_after INTEGER NOT NULL,
  chars_before INTEGER NOT NULL,
  chars_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

export const configSchemaReady = true;
addColumn('memory_jobs', 'compact_error', 'TEXT');
addColumn('memory_jobs', 'compact_error_at', 'INTEGER');
