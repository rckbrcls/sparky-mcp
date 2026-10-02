import { randomUUID } from "node:crypto";
import { cleanupPairing } from "./pairing.js";
import { db } from "./db.js";
import { commandPayloadSchemas, commandResultSchema, type CommandResult, type CommandType } from "./schema.js";

interface CommandRow {
  id: string;
  type: CommandType;
  target_id: string | null;
  base_version: string | null;
  payload: string;
  status: "pending" | "claimed" | CommandResult["status"];
  result: string | null;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
}
function command(row: CommandRow) {
  return {
    id: row.id, type: row.type, targetId: row.target_id, baseVersion: row.base_version,
    payload: JSON.parse(row.payload) as Record<string, unknown>, createdAt: row.created_at,
  };
}

export function enqueue(type: CommandType, targetId: string | null, baseVersion: string | null, payload: unknown): string {
  const parsed = commandPayloadSchemas[type].parse(payload);
  const id = randomUUID();
  db.prepare(`INSERT INTO commands (id, type, target_id, base_version, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, type, targetId, baseVersion, JSON.stringify(parsed), new Date().toISOString());
  return id;
}

export function claimPending(limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = new Date();
    db.prepare(`UPDATE commands SET status = 'pending', claimed_at = NULL
      WHERE status = 'claimed' AND claimed_at < ?`)
      .run(new Date(now.getTime() - 5 * 60 * 1000).toISOString());
    const rows = db.prepare(`SELECT * FROM commands WHERE status = 'pending'
      ORDER BY created_at ASC, rowid ASC LIMIT ?`).all(limit) as unknown as CommandRow[];
    const claim = db.prepare("UPDATE commands SET status = 'claimed', claimed_at = ? WHERE id = ?");
    for (const row of rows) claim.run(now.toISOString(), row.id);
    db.exec("COMMIT");
    return rows.map(command);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function reportResult(id: string, status: CommandResult["status"], result?: Record<string, unknown>, error?: string): boolean {
  const body = commandResultSchema.parse({ status, result, error });
  const updated = db.prepare(`UPDATE commands SET status = ?, result = ?, error = ?, finished_at = ?
    WHERE id = ? AND status IN ('pending', 'claimed')`).run(
    body.status, body.result === undefined ? null : JSON.stringify(body.result), body.error ?? null,
    new Date().toISOString(), id,
  );
  return Number(updated.changes) > 0 || getCommand(id) !== null;
}

export function getCommand(id: string) {
  const row = db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as unknown as CommandRow | undefined;
  if (!row) return null;
  return {
    ...command(row), status: row.status,
    result: row.result === null ? null : JSON.parse(row.result) as Record<string, unknown>,
    error: row.error, claimedAt: row.claimed_at, finishedAt: row.finished_at,
  };
}

export function purgeFinished(): void {
  db.prepare(`DELETE FROM commands WHERE status IN ('done', 'failed', 'conflict') AND finished_at < ?`)
    .run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
}

export function startCommandMaintenance(): void {
  const maintain = () => { purgeFinished(); cleanupPairing(db); };
  maintain();
  setInterval(maintain, 60 * 60 * 1000).unref();
}
