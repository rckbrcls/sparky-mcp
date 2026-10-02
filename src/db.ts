import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { pairingSchema } from "./pairing-schema.js";
import { config } from "./config.js";

mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(join(config.dataDir, "sparky-mcp.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  DROP TABLE IF EXISTS inbox;
  DROP TABLE IF EXISTS snapshot;

  CREATE TABLE IF NOT EXISTS mirror (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    target_id TEXT,
    base_version TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS commands_status_created_at ON commands (status, created_at);

  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

db.exec(pairingSchema);
