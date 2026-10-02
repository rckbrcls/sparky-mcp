import { db } from "./db.js";
import { mirrorSchema, type ListMemoriesInput, type Mind, type Mirror } from "./schema.js";

export type MirrorState = Omit<Mirror, "syncedAt"> & { syncedAt: string | null; stale?: true };

export function getMirror(): MirrorState {
  const row = db.prepare("SELECT value FROM mirror WHERE key = 'main'").get() as { value: string } | undefined;
  if (!row) return { syncedAt: null, minds: [], memories: [], stale: true };
  const mirror = mirrorSchema.parse(JSON.parse(row.value));
  return { ...mirror, ...(Date.now() - Date.parse(mirror.syncedAt) > 24 * 60 * 60 * 1000 ? { stale: true as const } : {}) };
}

export function setMirror(mirror: Mirror): void {
  const value = mirrorSchema.parse(mirror);
  db.prepare(`INSERT INTO mirror (key, value, updated_at) VALUES ('main', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(JSON.stringify(value), new Date().toISOString());
}

export function mirrorMetadata(mirror: MirrorState) {
  return { syncedAt: mirror.syncedAt, ...(mirror.stale ? { stale: true as const } : {}) };
}

export function findMind(nameOrId: string, mirror = getMirror()): Mind {
  const wanted = nameOrId.trim().toLowerCase();
  const match = mirror.minds.find((mind) => mind.id === wanted)
    ?? mirror.minds.find((mind) => mind.name.trim().toLowerCase() === wanted);
  if (!match) throw new Error(`Unknown mind: ${nameOrId}. Available minds: ${mirror.minds.map((mind) => `${mind.name} (${mind.id})`).join(", ") || "(none synced yet)"}`);
  return match;
}

export function listMemories(input: ListMemoriesInput, mirror = getMirror()) {
  const mindId = input.mind === undefined ? undefined : findMind(input.mind, mirror).id;
  const query = input.query?.toLowerCase();
  const memories = mirror.memories.filter((memory) => {
    if (mindId !== undefined && memory.mindId !== mindId) return false;
    if (input.status !== undefined && memory.status !== input.status) return false;
    if (input.pinned !== undefined && memory.isPinned !== input.pinned) return false;
    if (input.dueFrom !== undefined && (memory.dueDate === null || Date.parse(memory.dueDate) < Date.parse(input.dueFrom))) return false;
    if (input.dueTo !== undefined && (memory.dueDate === null || Date.parse(memory.dueDate) > Date.parse(input.dueTo))) return false;
    if (query && ![memory.title, memory.note ?? "", ...memory.checklist.flatMap((item) => [item.title, item.detail])]
      .some((value) => value.toLowerCase().includes(query))) return false;
    return true;
  }).slice(0, input.limit).map(({ id, title, status, isPinned, priority, dueDate, mindId, updatedAt }) => ({
    id, title, status, isPinned, priority, dueDate, mindId, updatedAt,
  }));
  return { ...mirrorMetadata(mirror), memories };
}

export interface MindTreeNode {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  parentId: string | null;
  children: MindTreeNode[];
}

export function mindTree(mirror: MirrorState): MindTreeNode[] {
  const nodes = new Map(mirror.minds.map((mind) => [mind.id, {
    id: mind.id, name: mind.name, color: mind.colorHex, icon: mind.iconName,
    parentId: mind.parentId, children: [] as MindTreeNode[],
  }]));
  const roots: MindTreeNode[] = [];
  for (const mind of [...mirror.minds].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const node = nodes.get(mind.id)!;
    const seen = new Set([mind.id]);
    let ancestor = mind.parentId;
    let cyclic = false;
    while (ancestor !== null && nodes.has(ancestor)) {
      if (seen.has(ancestor)) { cyclic = true; break; }
      seen.add(ancestor);
      ancestor = nodes.get(ancestor)!.parentId;
    }
    const parent = mind.parentId === null ? undefined : nodes.get(mind.parentId);
    if (parent && !cyclic) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
