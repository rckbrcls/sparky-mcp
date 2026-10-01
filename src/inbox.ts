import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { snapshotSchema, type MemoryInput, type Snapshot } from "./schema.js";

export interface InboxItem {
  id: string;
  createdAt: string;
  mindId: string | null;
  memory: MemoryInput;
}

export function getSnapshot(): Snapshot {
  const row = db.prepare("SELECT value FROM snapshot WHERE key = 'main'").get() as { value: string } | undefined;
  return row ? snapshotSchema.parse(JSON.parse(row.value)) : { minds: [], tags: [] };
}

export function setSnapshot(snapshot: Snapshot): void {
  db.prepare(
    `INSERT INTO snapshot (key, value, updated_at) VALUES ('main', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(snapshot), new Date().toISOString());
}

export class UnknownMindError extends Error {
  constructor(public readonly available: string[]) {
    super(`Unknown mind. Available minds: ${available.join(", ") || "(none synced yet)"}`);
  }
}

export function enqueue(memory: MemoryInput): InboxItem {
  let mindId: string | null = null;
  if (memory.mind) {
    const snapshot = getSnapshot();
    const wanted = memory.mind.trim().toLowerCase();
    const match = snapshot.minds.find((mind) => mind.name.trim().toLowerCase() === wanted);
    if (!match) throw new UnknownMindError(snapshot.minds.map((mind) => mind.name));
    mindId = match.id;
  }

  const item: InboxItem = { id: randomUUID(), createdAt: new Date().toISOString(), mindId, memory };
  db.prepare("INSERT INTO inbox (id, payload, status, created_at) VALUES (?, ?, 'pending', ?)").run(
    item.id,
    JSON.stringify(item),
    item.createdAt,
  );
  return item;
}

export function listPending(limit = 100): InboxItem[] {
  const rows = db
    .prepare("SELECT payload FROM inbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
    .all(limit) as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload) as InboxItem);
}

export function acknowledge(ids: string[]): number {
  const stmt = db.prepare("UPDATE inbox SET status = 'imported', imported_at = ? WHERE id = ? AND status = 'pending'");
  const now = new Date().toISOString();
  let changed = 0;
  for (const id of ids) changed += Number(stmt.run(now, id).changes);
  return changed;
}

export function pendingCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'").get() as { n: number };
  return row.n;
}
