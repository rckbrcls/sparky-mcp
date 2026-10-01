import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { enqueue, getSnapshot, pendingCount, UnknownMindError } from "./inbox.js";
import { memoryInputShape } from "./schema.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "sparky", version: "0.1.0" });

  server.registerTool(
    "get_current_time",
    {
      description: "Returns the current date/time and the user's time zone. Call before building any fireDate.",
    },
    async () => {
      const now = new Date();
      return text({
        nowUtc: now.toISOString(),
        timeZone: config.timeZone,
        nowLocal: now.toLocaleString("en-US", { timeZone: config.timeZone, dateStyle: "full", timeStyle: "long" }),
      });
    },
  );

  server.registerTool(
    "list_minds",
    { description: "Lists the user's Minds (folders) that a memory can be filed into." },
    async () => {
      const { minds } = getSnapshot();
      return text(minds.length ? minds.map((m) => m.name) : "No minds synced yet. Memories will go to the Inbox.");
    },
  );

  server.registerTool(
    "list_tags",
    { description: "Lists the user's tags." },
    async () => {
      const { tags } = getSnapshot();
      return text(tags.map((t) => t.name));
    },
  );

  server.registerTool(
    "create_memory",
    {
      description:
        "Creates a memory (reminder, note or checklist) in the user's Sparky app. It is queued and imported the next time the app syncs, so it may not appear instantly.",
      inputSchema: memoryInputShape,
    },
    async (input) => {
      if (input.recurrence && !input.fireDate) {
        return { ...text("recurrence requires fireDate"), isError: true };
      }
      try {
        const item = enqueue(input as Parameters<typeof enqueue>[0]);
        return text({ queued: true, id: item.id, pendingInQueue: pendingCount() });
      } catch (error) {
        if (error instanceof UnknownMindError) return { ...text(error.message), isError: true };
        throw error;
      }
    },
  );

  return server;
}
