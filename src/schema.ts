import { z } from "zod";

const isoDateTime = z.iso.datetime({ offset: true });

export const weekdaySchema = z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

export const memoryInputShape = {
  title: z.string().min(1).max(200).describe("Short title of the memory."),
  note: z.string().max(10_000).optional().describe("Longer free-text note."),
  mind: z
    .string()
    .optional()
    .describe("Name of the Mind (folder) to file it in. Use list_minds to see valid names. Omit for the Inbox."),
  isPinned: z.boolean().optional(),
  fireDate: isoDateTime
    .optional()
    .describe(
      "When to notify, ISO 8601 WITH a UTC offset, e.g. 2026-10-02T09:00:00-03:00. Call get_current_time first for relative dates like 'tomorrow'.",
    ),
  allDay: z.boolean().optional().describe("Treat fireDate as an all-day reminder."),
  recurrence: z
    .object({
      frequency: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
      interval: z.number().int().min(1).max(999).default(1),
      weekdays: z.array(weekdaySchema).optional().describe("Only for weekly recurrence."),
      endDate: isoDateTime.optional().describe("Stop repeating after this date."),
    })
    .optional()
    .describe("Repeat the reminder. Requires fireDate."),
  location: z
    .object({
      name: z.string().max(200).optional(),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusMeters: z.number().min(50).max(10_000).default(200),
      event: z.enum(["onEntry", "onExit"]).default("onEntry"),
    })
    .optional()
    .describe("Notify when arriving at or leaving a place."),
  checklist: z
    .array(z.object({ title: z.string().min(1).max(200), detail: z.string().max(1000).optional() }))
    .max(100)
    .optional(),
};

export const memoryInputSchema = z.object(memoryInputShape);
export type MemoryInput = z.infer<typeof memoryInputSchema>;

export const snapshotSchema = z.object({
  minds: z.array(z.object({ id: z.string(), name: z.string(), parentId: z.string().nullable().optional() })),
  tags: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
