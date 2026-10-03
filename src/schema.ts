import { z } from "zod";
import { config } from "./config.js";

export const idSchema = z.uuid().regex(/^[0-9a-f-]+$/, "IDs must be lowercase UUIDs.");
const dateSchema = z.iso.datetime({ precision: 3 });
export const inputDateSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const weekdaySchema = z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
export const statusSchema = z.enum(["active", "completed"]);

function recurrence(date: typeof dateSchema | typeof inputDateSchema) {
  return z.strictObject({
    frequency: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    weekdays: z.array(weekdaySchema).optional(),
    endDate: date.nullable(),
    occurrenceCount: z.number().int().positive().nullable(),
  }).superRefine((value, ctx) => {
    if (value.endDate !== null && value.occurrenceCount !== null) {
      ctx.addIssue({ code: "custom", message: "endDate and occurrenceCount are mutually exclusive." });
    }
    if (value.weekdays !== undefined && value.frequency !== "weekly") {
      ctx.addIssue({ code: "custom", message: "weekdays are only valid for weekly recurrence." });
    }
  });
}
export const recurrenceSchema = recurrence(dateSchema);
export const focusSchema = z.strictObject({
  enabled: z.boolean(),
  workMinutes: z.number().int().positive(),
  shortBreakMinutes: z.number().int().positive(),
  longBreakMinutes: z.number().int().positive(),
  pomodorosUntilLongBreak: z.number().int().positive(),
  autoContinue: z.boolean(),
});
function schedule(date: typeof dateSchema | typeof inputDateSchema) {
  return z.strictObject({
    fireDate: date,
    isAllDay: z.boolean(),
    timeZone: z.string().min(1).refine((value) => {
      try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
    }, "Invalid time zone."),
    isActive: z.boolean(),
    recurrence: recurrence(date).nullable(),
    focus: focusSchema.nullable(),
  });
}
export const scheduleSchema = schedule(dateSchema);
export const locationSchema = z.strictObject({
  name: z.string(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().positive(),
  event: z.enum(["onEntry", "onExit"]),
  isActive: z.boolean(),
});
export const checklistItemSchema = z.strictObject({
  id: idSchema,
  title: z.string().min(1),
  detail: z.string(),
  isCompleted: z.boolean(),
  sortOrder: z.number().int(),
});
const inputChecklistItemSchema = checklistItemSchema.extend({ id: idSchema.optional() });
export const linkSchema = z.strictObject({ url: z.url(), title: z.string().nullable() });

const mindFields = {
  name: z.string().trim().min(1),
  colorHex: z.string().nullable(),
  iconName: z.string().nullable(),
  sortOrder: z.number().int(),
  parentId: idSchema.nullable(),
};
export const mindSchema = z.strictObject({
  id: idSchema, ...mindFields, isDefault: z.boolean(), updatedAt: dateSchema,
});
function memoryFields(date: typeof dateSchema | typeof inputDateSchema) {
  return {
    title: z.string().min(1),
    note: z.string().nullable(),
    status: statusSchema,
    isPinned: z.boolean(),
    priority: z.number().int().nullable(),
    dueDate: date.nullable(),
    mindId: idSchema.nullable(),
    completedAt: date.nullable(),
    completedDates: z.array(date),
    autoCompleteOnChecklistCompletion: z.boolean(),
    checklist: z.array(checklistItemSchema),
    schedule: schedule(date).nullable(),
    location: locationSchema.nullable(),
    links: z.array(linkSchema),
  };
}
export const memorySchema = z.strictObject({
  id: idSchema, ...memoryFields(dateSchema), createdAt: dateSchema, updatedAt: dateSchema,
});
export const mirrorSchema = z.strictObject({
  syncedAt: dateSchema, minds: z.array(mindSchema), memories: z.array(memorySchema),
});
export type Mind = z.infer<typeof mindSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type Mirror = z.infer<typeof mirrorSchema>;

const editableMemorySchema = z.strictObject({
  ...memoryFields(inputDateSchema), checklist: z.array(inputChecklistItemSchema),
});
export const memoryCreatePayloadSchema = editableMemorySchema.omit({
  status: true, completedAt: true, completedDates: true,
});
export const memoryPatchSchema = editableMemorySchema.partial();
export const memoryUpdatePayloadSchema = z.strictObject({ patch: memoryPatchSchema });
export const memorySetStatusPayloadSchema = z.strictObject({
  status: statusSchema, occurrenceDate: inputDateSchema.nullable().default(null),
});
export const memoryToggleCheckItemPayloadSchema = z.strictObject({
  itemId: idSchema, occurrenceDate: inputDateSchema.nullable().default(null),
});
export const mindCreatePayloadSchema = z.strictObject(mindFields);
export const mindPatchSchema = mindCreatePayloadSchema.partial();
export const mindUpdatePayloadSchema = z.strictObject({ patch: mindPatchSchema });
export const emptyPayloadSchema = z.strictObject({});
export const commandPayloadSchemas = {
  "memory.create": memoryCreatePayloadSchema,
  "memory.update": memoryUpdatePayloadSchema,
  "memory.setStatus": memorySetStatusPayloadSchema,
  "memory.toggleCheckItem": memoryToggleCheckItemPayloadSchema,
  "memory.delete": emptyPayloadSchema,
  "mind.create": mindCreatePayloadSchema,
  "mind.update": mindUpdatePayloadSchema,
  "mind.delete": emptyPayloadSchema,
};
export type CommandType = keyof typeof commandPayloadSchemas;
export const commandResultSchema = z.strictObject({
  status: z.enum(["done", "failed", "conflict"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;

export const listMemoriesInputShape = {
  mind: z.string().optional().describe("Mind name (case-insensitive) or UUID."),
  status: statusSchema.optional(),
  pinned: z.boolean().optional(),
  dueFrom: inputDateSchema.optional().describe("Inclusive due date lower bound; ISO 8601 with UTC offset."),
  dueTo: inputDateSchema.optional().describe("Inclusive due date upper bound; ISO 8601 with UTC offset."),
  updatedFrom: inputDateSchema.optional().describe("Inclusive updatedAt lower bound; ISO 8601 with UTC offset. Call get_current_time first for relative dates."),
  updatedTo: inputDateSchema.optional().describe("Inclusive updatedAt upper bound; ISO 8601 with UTC offset. Call get_current_time first for relative dates."),
  query: z.string().optional().describe("Case-insensitive search in title, note, and checklist text."),
  limit: z.number().int().positive().default(50),
};
export const listMemoriesInputSchema = z.strictObject(listMemoriesInputShape);
export type ListMemoriesInput = z.infer<typeof listMemoriesInputSchema>;
// Tool inputs reject unknown fields. Omitted fields still receive defaults.
const timeZoneSchema = scheduleSchema.shape.timeZone;
const toolRecurrenceSchema = z.strictObject({
  frequency: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().positive().default(1),
  weekdays: z.array(weekdaySchema).optional().describe("Weekly only."),
  endDate: inputDateSchema.nullable().default(null),
  occurrenceCount: z.number().int().positive().nullable().default(null).describe("Mutually exclusive with endDate."),
});
const toolFocusSchema = z.strictObject({
  enabled: z.boolean().default(true),
  workMinutes: z.number().int().positive().default(25),
  shortBreakMinutes: z.number().int().positive().default(5),
  longBreakMinutes: z.number().int().positive().default(15),
  pomodorosUntilLongBreak: z.number().int().positive().default(4),
  autoContinue: z.boolean().default(true),
});
const toolScheduleSchema = z.strictObject({
  fireDate: inputDateSchema.describe("ISO 8601 WITH a UTC offset. Call get_current_time first for relative dates."),
  isAllDay: z.boolean().default(false),
  timeZone: timeZoneSchema.default(config.timeZone),
  isActive: z.boolean().default(true),
  recurrence: toolRecurrenceSchema.nullable().default(null),
  focus: toolFocusSchema.nullable().default(null),
});
const toolLocationSchema = z.strictObject({
  name: z.string().default(""),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().positive().default(200),
  event: z.enum(["onEntry", "onExit"]).default("onEntry"),
  isActive: z.boolean().default(true),
});
const toolChecklistItemSchema = z.strictObject({
  id: idSchema.optional().describe("Keep an existing item's identity; omit for new items."),
  title: z.string().min(1),
  detail: z.string().default(""),
  isCompleted: z.boolean().default(false),
  sortOrder: z.number().int().optional().describe("Defaults to the position in the list."),
});
const toolLinkSchema = z.strictObject({ url: z.url(), title: z.string().nullable().default(null) });

/** Fills `sortOrder` from list position; call before queuing a command. */
export function withChecklistOrder<T extends { checklist?: { sortOrder?: number }[] }>(fields: T): T {
  if (!fields.checklist) return fields;
  return { ...fields, checklist: fields.checklist.map((item, index) => ({ ...item, sortOrder: item.sortOrder ?? index })) };
}

const toolMemoryFields = {
  title: z.string().trim().min(1),
  note: z.string().nullable(),
  isPinned: z.boolean(),
  priority: z.number().int().nullable(),
  dueDate: inputDateSchema.nullable(),
  autoCompleteOnChecklistCompletion: z.boolean(),
  checklist: z.array(toolChecklistItemSchema),
  schedule: toolScheduleSchema.nullable(),
  location: toolLocationSchema.nullable(),
  links: z.array(toolLinkSchema),
};
const mindRef = z.string().nullable().optional().describe("Mind name or UUID; omit or null for the Inbox.");
export const createMemoryInputShape = {
  title: toolMemoryFields.title,
  note: toolMemoryFields.note.default(null),
  isPinned: toolMemoryFields.isPinned.default(false),
  priority: toolMemoryFields.priority.default(null),
  dueDate: toolMemoryFields.dueDate.default(null),
  autoCompleteOnChecklistCompletion: toolMemoryFields.autoCompleteOnChecklistCompletion.default(false),
  checklist: toolMemoryFields.checklist.default([]),
  schedule: toolMemoryFields.schedule.default(null),
  location: toolMemoryFields.location.default(null),
  links: toolMemoryFields.links.default([]),
  mind: mindRef,
};
const toolMemoryPatchSchema = z.strictObject({ ...toolMemoryFields, mindId: idSchema.nullable() }).partial();
const targetShape = { id: idSchema, baseVersion: inputDateSchema.optional().describe("Entity updatedAt; defaults to the mirror version.") };
export const updateMemoryInputShape = {
  ...targetShape,
  patch: toolMemoryPatchSchema.extend({ mind: z.string().nullable().optional().describe("Mind name or UUID; null clears the folder.") })
    .refine((value) => !("mind" in value && "mindId" in value), "Use either mind or mindId, not both."),
};
export const setMemoryStatusInputShape = { ...targetShape, ...memorySetStatusPayloadSchema.shape };
export const toggleCheckItemInputShape = { ...targetShape, ...memoryToggleCheckItemPayloadSchema.shape };
export const deleteEntityInputShape = { ...targetShape, confirm: z.literal(true) };
export const createMindInputShape = mindCreatePayloadSchema.extend({
  colorHex: z.string().nullable().default(null),
  iconName: z.string().nullable().default(null),
  sortOrder: z.number().int().default(0),
  parentId: idSchema.nullable().default(null),
}).shape;
export const updateMindInputShape = { ...targetShape, patch: mindPatchSchema };
export const idInputShape = { id: idSchema };
export const idInputSchema = z.strictObject(idInputShape);
export const createMemoryInputSchema = z.strictObject(createMemoryInputShape);
export const updateMemoryInputSchema = z.strictObject(updateMemoryInputShape);
export const setMemoryStatusInputSchema = z.strictObject(setMemoryStatusInputShape);
export const toggleCheckItemInputSchema = z.strictObject(toggleCheckItemInputShape);
export const deleteEntityInputSchema = z.strictObject(deleteEntityInputShape);
export const createMindInputSchema = z.strictObject(createMindInputShape);
export const updateMindInputSchema = z.strictObject(updateMindInputShape);
