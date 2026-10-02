export const pairingSchema = `
  CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS pairing_lockout (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO pairing_lockout (id) VALUES (1);
`;
