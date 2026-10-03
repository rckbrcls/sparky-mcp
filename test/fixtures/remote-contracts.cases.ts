// Run only through remote-contracts.test.ts: environment isolation must precede imports.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import * as schema from "../../src/schema.js";
import { db } from "../../src/db.js";
import { api } from "../../src/api.js";
import { createMcpServer } from "../../src/mcp.js";
import { enqueue, claimPending, getCommand, reportResult, purgeFinished } from "../../src/commands.js";
import { getMirror, setMirror, listMemories, mindTree } from "../../src/mirror.js";

const date = "2026-10-02T12:00:00.000Z";
const rootId = randomUUID(), memoryId = randomUUID(), itemId = randomUUID();
const mind = (patch: Partial<schema.Mind> = {}): schema.Mind => ({ id: rootId, name: "Work", colorHex: null,
  iconName: null, sortOrder: 0, parentId: null, isDefault: false, updatedAt: date, ...patch });
const memory = (patch: Partial<schema.Memory> = {}): schema.Memory => ({ id: memoryId, title: "Café 🚀", note: "NOTE Needle",
  status: "active", isPinned: true, priority: 2, dueDate: date, mindId: rootId, completedAt: null,
  completedDates: [], autoCompleteOnChecklistCompletion: false, checklist: [{ id: itemId, title: "Checklist Needle",
    detail: "Detail Needle", isCompleted: false, sortOrder: 0 }], schedule: null, location: null, links: [],
  createdAt: date, updatedAt: date, ...patch });
const schedule = (patch: Record<string, unknown> = {}) => ({ fireDate: date, isAllDay: false,
  timeZone: "America/Sao_Paulo", isActive: false, recurrence: null, focus: null, ...patch });
function seed() { setMirror({ syncedAt: new Date().toISOString(), minds: [mind()], memories: [memory()] }); }
const headers = { Authorization: "Bearer synthetic-test-token", "Content-Type": "application/json" };
const server = createMcpServer();
const client = new Client({ name: "sparky-contract-tests", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  const text = content.find(c => c.type === "text")!.text!;
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { error: result.isError === true, data };
}
beforeEach(() => { db.exec("DELETE FROM commands; DELETE FROM mirror"); seed(); });
afterAll(async () => { await client.close(); await server.close(); db.close(); });

test("all 13 registered tools match the declared contract", async () => {
  const tools = await client.listTools();
  expect(tools.tools.map(t => t.name).sort()).toEqual([
    "get_current_time", "list_minds", "list_memories", "get_memory", "get_command_status",
    "create_memory", "update_memory", "set_memory_status", "toggle_check_item", "delete_memory",
    "create_mind", "update_mind", "delete_mind"].sort());
  expect((await call("get_current_time")).data.timeZone).toBe("America/Sao_Paulo");
  expect((await call("get_memory", { id: memoryId })).data.memory).toEqual(memory());
  expect((await call("list_minds")).data.minds[0].id).toBe(rootId);
});

test("minimal creation defaults, Unicode, checklist order, and Mind name resolution", async () => {
  const response = await call("create_memory", { title: "Café 🚀", mind: " wOrK ", checklist: [{ title: "A" }, { title: "B", sortOrder: 8 }] });
  expect(response.error).toBe(false);
  const command = getCommand(response.data.commandId)!;
  expect(command.status).toBe("pending");
  expect(command.payload).toMatchObject({ title: "Café 🚀", mindId: rootId, note: null,
    isPinned: false, priority: null, dueDate: null, schedule: null, location: null, links: [],
    checklist: [{ title: "A", sortOrder: 0 }, { title: "B", sortOrder: 8 }] });
  expect((await call("get_command_status", { id: command.id })).data.command.status).toBe("pending");
});

test("all eight write tools queue correct type and version", async () => {
  const operations = [
    ["create_memory", { title: "New" }, "memory.create"],
    ["update_memory", { id: memoryId, patch: { title: "Edited" } }, "memory.update"],
    ["set_memory_status", { id: memoryId, status: "completed", occurrenceDate: date }, "memory.setStatus"],
    ["toggle_check_item", { id: memoryId, itemId, occurrenceDate: date }, "memory.toggleCheckItem"],
    ["delete_memory", { id: memoryId, confirm: true }, "memory.delete"],
    ["create_mind", { name: "Child", parentId: rootId }, "mind.create"],
    ["update_mind", { id: rootId, patch: { name: "Edited", colorHex: null, iconName: "folder", sortOrder: 5, parentId: null } }, "mind.update"],
    ["delete_mind", { id: rootId, confirm: true }, "mind.delete"],
  ] as const;
  for (const [name, args, type] of operations) {
    const response = await call(name, args);
    expect(response.error).toBe(false);
    const command = getCommand(response.data.commandId)!;
    expect(command.type).toBe(type);
    expect(command.baseVersion).toBe(type.endsWith("create") ? null : date);
  }
});

test("patch omission, null, empty lists, identity and explicit baseVersion are preserved", async () => {
  for (const patch of [{ note: null, mind: null, priority: null, dueDate: null, schedule: null, location: null },
    { checklist: [], links: [] }, { checklist: [{ id: itemId, title: "Renamed", isCompleted: true, sortOrder: 3 }] }]) {
    const r = await call("update_memory", { id: memoryId, baseVersion: "2026-10-01T23:59:59-03:00", patch });
    const command = getCommand(r.data.commandId)!;
    expect(command.baseVersion).toBe("2026-10-02T02:59:59.000Z");
    expect(command.payload.patch).not.toHaveProperty("title");
    if ("mind" in patch) expect(command.payload.patch).toMatchObject({ mindId: null, note: null });
    if ("links" in patch) expect(command.payload.patch).toEqual({ checklist: [], links: [] });
  }
});

test("missing entities and invalid cross-field inputs reject without enqueue", async () => {
  const absent = randomUUID();
  const cases: [string, Record<string, unknown>][] = [
    ["get_memory", { id: absent }], ["get_command_status", { id: absent }],
    ["create_memory", { title: "X", mind: "missing" }],
    ["create_mind", { name: "X", parentId: absent }],
    ["update_memory", { id: absent, patch: {} }],
    ["update_memory", { id: memoryId, patch: { mind: "Work", mindId: rootId } }],
    ["update_mind", { id: rootId, patch: { parentId: absent } }],
    ["toggle_check_item", { id: memoryId, itemId: absent }],
    ["delete_memory", { id: memoryId, confirm: false }],
    ["delete_mind", { id: rootId }],
    ["create_memory", { title: "" }],
    ["create_memory", { title: "X", schedule: schedule({ recurrence: { frequency: "daily", interval: 1, endDate: date, occurrenceCount: 2 } }) }],
    ["create_memory", { title: "X", schedule: schedule({ recurrence: { frequency: "daily", weekdays: ["mon"] } }) }],
  ];
  for (const [name, args] of cases) expect((await call(name, args)).error).toBe(true);
  expect(claimPending()).toEqual([]);
});

test("whitespace-only Memory title is rejected before queuing", async () => {
  expect((await call("create_memory", { title: "   " })).error).toBe(true);
  expect(claimPending()).toEqual([]);
});

test("unknown tool input fields are rejected rather than silently discarded", async () => {
  expect((await call("create_memory", { title: "X", unsupported: true })).error).toBe(true);
});

test.each(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"])("%s recurrence survives payload normalization", async frequency => {
  const recurrence = { frequency, interval: 2, occurrenceCount: 4, ...(frequency === "weekly" ? { weekdays: ["mon", "fri"] } : {}) };
  const r = await call("create_memory", { title: "Schedule", schedule: {
    fireDate: "2028-02-29T23:30:00-03:00", timeZone: "America/Sao_Paulo", isAllDay: true, isActive: false,
    recurrence, focus: { enabled: false, workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosUntilLongBreak: 4, autoContinue: false } },
    location: { latitude: -90, longitude: 180, radiusMeters: 1, event: "onExit", isActive: false },
    links: [{ url: "https://example.com/", title: "Example" }] });
  expect(r.error).toBe(false);
  expect(getCommand(r.data.commandId)!.payload.schedule).toMatchObject({ fireDate: "2028-03-01T02:30:00.000Z", isAllDay: true,
    recurrence: { frequency, interval: 2, occurrenceCount: 4, endDate: null }, focus: { autoContinue: false } });
});

test.each(["2026-12-31T23:30:00-03:00", "2026-01-31T23:30:00-03:00", "2028-02-29T23:30:00-03:00"])("offset normalization across boundaries: %s", value => {
  expect(schema.inputDateSchema.parse(value)).toBe(new Date(value).toISOString());
});

test("schema rejects invalid UUID, dates, timezone, URL, location and focus bounds", () => {
  for (const value of ["bad", rootId.toUpperCase()]) expect(schema.idSchema.safeParse(value).success).toBe(false);
  for (const value of ["2026-10-02T12:00:00", "not-a-date", "2026-02-30T12:00:00Z"]) expect(schema.inputDateSchema.safeParse(value).success).toBe(false);
  expect(schema.scheduleSchema.safeParse(schedule({ timeZone: "Invalid/Zone" })).success).toBe(false);
  for (const [latitude, longitude, radiusMeters] of [[91, 0, 1], [0, -181, 1], [0, 0, 0]])
    expect(schema.locationSchema.safeParse({ name: "", latitude, longitude, radiusMeters, event: "onEntry", isActive: false }).success).toBe(false);
  expect(schema.linkSchema.safeParse({ url: "not a URL", title: null }).success).toBe(false);
  expect(schema.focusSchema.safeParse({ enabled: false, workMinutes: 0, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosUntilLongBreak: 4, autoContinue: false }).success).toBe(false);
  expect(z.object(schema.listMemoriesInputShape).safeParse({ limit: 0 }).success).toBe(false);
});

test("queries cover case-folding, combined filters, inclusive date boundaries and limits", () => {
  const state = { syncedAt: date, minds: [mind()], memories: [memory(), memory({ id: randomUUID(), title: "Other", note: null, checklist: [], status: "completed", isPinned: false, dueDate: null })] };
  for (const query of ["CAFÉ", "note needle", "CHECKLIST NEEDLE", "detail needle"]) expect(listMemories({ query, limit: 50 }, state).memories.map(m => m.id)).toEqual([memoryId]);
  expect(listMemories({ mind: "work", status: "active", pinned: true, dueFrom: date, dueTo: date, limit: 50 }, state).memories).toHaveLength(1);
  expect(listMemories({ mind: rootId, limit: 1 }, state).memories).toHaveLength(1);
  expect(listMemories({ query: "missing", limit: 50 }, state).memories).toEqual([]);
  expect(listMemories({ status: "completed", pinned: false, limit: 50 }, state).memories).toHaveLength(1);
  expect(listMemories({ dueFrom: "2026-10-02T12:00:00.001Z", limit: 50 }, state).memories).toEqual([]);
  const olderId = "10000000-0000-4000-8000-000000000001";
  const newerLowId = "20000000-0000-4000-8000-000000000002";
  const newerHighId = "30000000-0000-4000-8000-000000000003";
  const olderAt = "2026-10-01T12:00:00.000Z";
  const newerAt = "2026-10-03T12:00:00.000Z";
  const recent = { syncedAt: date, minds: [mind()], memories: [
    memory({ id: olderId, title: "Older", updatedAt: olderAt }),
    memory({ id: newerHighId, title: "Newer high", updatedAt: newerAt }),
    memory({ id: newerLowId, title: "Newer low", updatedAt: newerAt }),
  ] };
  expect(listMemories({ limit: 1 }, recent).memories.map(m => m.id)).toEqual([newerLowId]);
  expect(listMemories({ limit: 3 }, recent).memories.map(m => m.id)).toEqual([newerLowId, newerHighId, olderId]);
  expect(listMemories({ updatedFrom: newerAt, updatedTo: newerAt, limit: 50 }, recent).memories.map(m => m.id)).toEqual([newerLowId, newerHighId]);
  expect(listMemories({ updatedFrom: olderAt, updatedTo: olderAt, limit: 50 }, recent).memories.map(m => m.id)).toEqual([olderId]);
  expect(listMemories({ updatedFrom: "2026-10-03T12:00:00.001Z", limit: 50 }, recent).memories).toEqual([]);
  expect(listMemories({ updatedTo: "2026-10-01T11:59:59.999Z", limit: 50 }, recent).memories).toEqual([]);
});

test("mirror full replacement, empty/stale metadata, malformed mirror atomicity and hierarchy order", () => {
  const child = mind({ id: randomUUID(), name: "Child", parentId: rootId, sortOrder: 1 });
  const grandchild = mind({ id: randomUUID(), name: "Grandchild", parentId: child.id });
  const mirror = { syncedAt: new Date(Date.now() - 25 * 3600_000).toISOString(), minds: [grandchild, child, mind()], memories: [memory()] };
  setMirror(mirror); expect(getMirror().stale).toBe(true);
  expect(mindTree(getMirror())[0]!.children[0]!.children[0]!.id).toBe(grandchild.id);
  expect(() => setMirror({ ...mirror, memories: [{ ...memory(), status: "invalid" } as unknown as schema.Memory] })).toThrow();
  expect(getMirror().memories).toHaveLength(1);
  setMirror({ syncedAt: new Date().toISOString(), minds: [], memories: [] }); expect(getMirror().memories).toEqual([]);
  db.exec("DELETE FROM mirror"); expect(getMirror()).toEqual({ syncedAt: null, minds: [], memories: [], stale: true });
});

test("cyclic and orphan Mind mirrors terminate and retain nodes", () => {
  const a = randomUUID(), b = randomUUID();
  const tree = mindTree({ syncedAt: date, minds: [mind({ id: a, parentId: b }), mind({ id: b, parentId: a }), mind({ id: randomUUID(), parentId: randomUUID() })], memories: [] });
  expect(tree).toHaveLength(3);
});

test("queue oldest-first and rowid tie ordering, non-overlapping claims and pending/claimed states", () => {
  const ids = Array.from({ length: 24 }, (_, i) => enqueue("mind.create", null, null, { name: `Mind ${i}`, colorHex: null, iconName: null, sortOrder: i, parentId: null }));
  db.prepare("UPDATE commands SET created_at = ?").run(date);
  expect(claimPending(20).map(c => c.id)).toEqual(ids.slice(0, 20));
  expect(claimPending(20).map(c => c.id)).toEqual(ids.slice(20));
  expect(claimPending()).toEqual([]); expect(getCommand(ids[0]!)!.status).toBe("claimed");
  for (const limit of [0, -1, 1.5, NaN]) expect(() => claimPending(limit)).toThrow();
});

test("expired claim is requeued after five minutes; recent claims remain claimed", () => {
  const ids = [0, 1].map(() => enqueue("mind.delete", rootId, date, {})); claimPending();
  db.prepare("UPDATE commands SET claimed_at = ? WHERE id = ?").run(new Date(Date.now() - 301_000).toISOString(), ids[0]!);
  expect(claimPending().map(c => c.id)).toEqual([ids[0]!]);
});

test.each(["done", "failed", "conflict"] as const)("%s terminal result cannot be overwritten", status => {
  const id = enqueue("mind.delete", rootId, date, {});
  expect(reportResult(id, status, { marker: "original" }, status === "done" ? undefined : "expected")).toBe(true);
  expect(reportResult(id, "done", { marker: "replacement" })).toBe(true);
  expect(getCommand(id)).toMatchObject({ status, result: { marker: "original" } });
  expect(reportResult(randomUUID(), "done")).toBe(false);
});

test("retention removes only terminal results older than 30 days", () => {
  const ids = Array.from({ length: 5 }, () => enqueue("mind.delete", rootId, date, {}));
  for (const id of ids.slice(0, 3)) reportResult(id, "done");
  const old = new Date(Date.now() - 31 * 86400_000).toISOString();
  db.prepare("UPDATE commands SET finished_at = ? WHERE id IN (?, ?)").run(old, ids[0]!, ids[1]!);
  purgeFinished(); expect(getCommand(ids[0]!)).toBeNull(); expect(getCommand(ids[2]!)).not.toBeNull(); expect(getCommand(ids[3]!)).not.toBeNull();
});

test("app API validates malformed requests and runs mirror → claim → report → read", async () => {
  expect((await api.request("/api/commands")).status).toBe(401);
  expect((await api.request("/api/commands", { headers: { Authorization: "Bearer invalid-synthetic" } })).status).toBe(401);
  expect((await api.request("/api/commands?limit=0", { headers })).status).toBe(400);
  expect((await api.request("/api/mirror", { method: "PUT", headers, body: "invalid json" })).status).toBe(400);
  const queued = await call("update_memory", { id: memoryId, patch: { title: "Round trip" } });
  const claimed = await (await api.request("/api/commands", { headers })).json();
  expect(claimed.commands[0].id).toBe(queued.data.commandId);
  const updated = memory({ title: "Round trip", updatedAt: "2026-10-02T12:00:01.000Z" });
  expect((await api.request(`/api/commands/${queued.data.commandId}/result`, { method: "POST", headers, body: JSON.stringify({ status: "done", result: { memory: updated } }) })).status).toBe(200);
  expect((await api.request("/api/mirror", { method: "PUT", headers, body: JSON.stringify({ syncedAt: new Date().toISOString(), minds: [mind()], memories: [updated] }) })).status).toBe(200);
  expect((await call("get_memory", { id: memoryId })).data.memory.title).toBe("Round trip");
  expect((await api.request(`/api/commands/${randomUUID()}/result`, { method: "POST", headers, body: JSON.stringify({ status: "done" }) })).status).toBe(404);
  expect((await api.request(`/api/commands/${queued.data.commandId}/result`, { method: "POST", headers, body: JSON.stringify({ status: "pending" }) })).status).toBe(400);
});
