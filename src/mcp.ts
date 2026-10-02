import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { enqueue, getCommand } from "./commands.js";
import { findMind, getMirror, listMemories, mindTree, mirrorMetadata, type MirrorState } from "./mirror.js";
import {
  createMemoryInputShape, createMindInputShape, deleteEntityInputShape, idInputShape,
  listMemoriesInputShape, setMemoryStatusInputShape, toggleCheckItemInputShape,
  updateMemoryInputShape, updateMindInputShape, type CommandType,
  withChecklistOrder,
} from "./schema.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
function respond(action: () => unknown) {
  try { return text(action()); }
  catch (error) {
    return { ...text({ error: error instanceof Error ? error.message : "Operation failed." }), isError: true };
  }
}
function pending(type: CommandType, targetId: string | null, baseVersion: string | null, payload: unknown) {
  return { commandId: enqueue(type, targetId, baseVersion, payload), status: "pending" };
}
function memoryTarget(id: string, mirror: MirrorState) {
  const memory = mirror.memories.find((memory) => memory.id === id);
  if (!memory) throw new Error(`Memory ${id} is not present in the mirror.`);
  return memory;
}
function mindTarget(id: string, mirror: MirrorState) {
  const mind = mirror.minds.find((mind) => mind.id === id);
  if (!mind) throw new Error(`Mind ${id} is not present in the mirror.`);
  return mind;
}
function validateMindId(id: string | null | undefined, mirror: MirrorState) {
  if (id !== undefined && id !== null) findMind(id, mirror);
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "sparky", version: "0.1.0" });

  server.registerTool("get_current_time", {
    description: "Returns the current date/time and the user's time zone. Call before building any fireDate or resolving relative dates.",
  }, async () => {
    const now = new Date();
    return text({
      nowUtc: now.toISOString(), timeZone: config.timeZone,
      nowLocal: now.toLocaleString("en-US", { timeZone: config.timeZone, dateStyle: "full", timeStyle: "long" }),
      ...mirrorMetadata(getMirror()),
    });
  });

  server.registerTool("list_minds", {
    description: "Returns the synced Mind folder tree with IDs, names, colors, icons, parentId, and children. Use these names or IDs when filing memories. Includes mirror sync time and stale=true when older than 24 hours.",
  }, async () => respond(() => {
    const mirror = getMirror();
    return { ...mirrorMetadata(mirror), minds: mindTree(mirror) };
  }));

  server.registerTool("list_memories", {
    description: "Returns memory summaries from the mirror. Filter by Mind name or ID, status, pinned state, inclusive due date range, or case-insensitive title/note/checklist text. Default limit is 50. Includes syncedAt and stale=true when applicable.",
    inputSchema: listMemoriesInputShape,
  }, async (input) => respond(() => listMemories(input)));

  server.registerTool("get_memory", {
    description: "Returns a full synced Memory by UUID, including checklist, schedule, location, links, and updatedAt version. Includes syncedAt and stale=true when applicable.",
    inputSchema: idInputShape,
  }, async ({ id }) => respond(() => {
    const mirror = getMirror();
    return { ...mirrorMetadata(mirror), memory: memoryTarget(id, mirror) };
  }));

  server.registerTool("get_command_status", {
    description: "Returns a queued command's state (pending, claimed, done, failed, conflict), result, and error by command UUID. Finished commands are retained for 30 days. Includes mirror sync metadata.",
    inputSchema: idInputShape,
  }, async ({ id }) => respond(() => {
    const command = getCommand(id);
    if (!command) throw new Error(`Command ${id} was not found.`);
    return { ...mirrorMetadata(getMirror()), command };
  }));

  server.registerTool("create_memory", {
    description: "Queues creation of a Memory in Sparky. Supply a title and optional note, Mind name or ID, pin, priority, dueDate, checklist, schedule (including recurrence/focus configuration), location, and links. Omit mind or use null for the default folder. Dates accept ISO 8601 with UTC offsets. Checklist IDs may be omitted for new items. Focus sessions cannot be controlled. Returns commandId and pending; the app applies it on sync.",
    inputSchema: createMemoryInputShape,
  }, async ({ mind, ...fields }) => respond(() => {
    const mirror = getMirror();
    const mindId = mind == null ? null : findMind(mind, mirror).id;
    return pending("memory.create", null, null, withChecklistOrder({ ...fields, mindId }));
  }));

  server.registerTool("update_memory", {
    description: "Queues a patch for an existing Memory UUID. Absent fields stay unchanged; null clears nullable fields. Checklist replaces the entire list; preserve item IDs to keep identity. Use patch.mind to resolve a folder name or ID, or patch.mindId directly. baseVersion defaults to the mirror's updatedAt; override with the version you saw. Returns commandId and pending; a changed version causes conflict when applied.",
    inputSchema: updateMemoryInputShape,
  }, async ({ id, baseVersion, patch }) => respond(() => {
    const mirror = getMirror();
    const memory = memoryTarget(id, mirror);
    const { mind, ...fields } = patch;
    if (mind !== undefined) fields.mindId = mind === null ? null : findMind(mind, mirror).id;
    validateMindId(fields.mindId, mirror);
    return pending("memory.update", id, baseVersion ?? memory.updatedAt, { patch: withChecklistOrder(fields) });
  }));

  server.registerTool("set_memory_status", {
    description: "Queues active or completed status for an existing Memory UUID. For a recurring memory, occurrenceDate marks one occurrence; omit it for the whole memory. baseVersion defaults to the mirror updatedAt. Returns commandId and pending.",
    inputSchema: setMemoryStatusInputShape,
  }, async ({ id, baseVersion, status, occurrenceDate }) => respond(() => {
    const memory = memoryTarget(id, getMirror());
    return pending("memory.setStatus", id, baseVersion ?? memory.updatedAt, { status, occurrenceDate });
  }));

  server.registerTool("toggle_check_item", {
    description: "Queues toggling a checklist item's completion for an existing Memory and item UUID. Optional occurrenceDate identifies a recurring occurrence. baseVersion defaults to the memory's mirror updatedAt. Returns commandId and pending.",
    inputSchema: toggleCheckItemInputShape,
  }, async ({ id, baseVersion, itemId, occurrenceDate }) => respond(() => {
    const memory = memoryTarget(id, getMirror());
    if (!memory.checklist.some((item) => item.id === itemId)) throw new Error(`Checklist item ${itemId} is not present in memory ${id}.`);
    return pending("memory.toggleCheckItem", id, baseVersion ?? memory.updatedAt, { itemId, occurrenceDate });
  }));

  server.registerTool("delete_memory", {
    description: "Queues deletion of an existing Memory UUID. Requires confirm:true. baseVersion defaults to the mirror updatedAt. Returns commandId and pending.",
    inputSchema: deleteEntityInputShape,
  }, async ({ id, baseVersion }) => respond(() => {
    const memory = memoryTarget(id, getMirror());
    return pending("memory.delete", id, baseVersion ?? memory.updatedAt, {});
  }));

  server.registerTool("create_mind", {
    description: "Queues creation of a Mind folder with name, optional colorHex, iconName, sortOrder, and parentId. A parent UUID must exist in the mirror. Returns commandId and pending.",
    inputSchema: createMindInputShape,
  }, async (input) => respond(() => {
    validateMindId(input.parentId, getMirror());
    return pending("mind.create", null, null, input);
  }));

  server.registerTool("update_mind", {
    description: "Queues a patch for an existing Mind UUID: name, colorHex, iconName, sortOrder, or parentId. Absent fields stay unchanged; null clears nullable fields. baseVersion defaults to the mirror updatedAt. Returns commandId and pending.",
    inputSchema: updateMindInputShape,
  }, async ({ id, baseVersion, patch }) => respond(() => {
    const mirror = getMirror();
    const mind = mindTarget(id, mirror);
    validateMindId(patch.parentId, mirror);
    return pending("mind.update", id, baseVersion ?? mind.updatedAt, { patch });
  }));

  server.registerTool("delete_mind", {
    description: "Queues deletion of an existing Mind and all its child Minds recursively. Memories in every deleted Mind move to the Inbox. Requires confirm:true. baseVersion defaults to the mirror updatedAt. Returns commandId and pending.",
    inputSchema: deleteEntityInputShape,
  }, async ({ id, baseVersion }) => respond(() => {
    const mind = mindTarget(id, getMirror());
    return pending("mind.delete", id, baseVersion ?? mind.updatedAt, {});
  }));

  return server;
}
