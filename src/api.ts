import { Hono } from "hono";
import { z } from "zod";
import { requireApiToken } from "./auth.js";
import { acknowledge, getSnapshot, listPending, setSnapshot } from "./inbox.js";
import { snapshotSchema } from "./schema.js";

export const api = new Hono();

api.use("/api/*", requireApiToken);

api.get("/api/inbox", (c) => c.json({ items: listPending() }));

api.post("/api/inbox/ack", async (c) => {
  const body = z.object({ ids: z.array(z.string()).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid body" }, 400);
  return c.json({ acknowledged: acknowledge(body.data.ids) });
});

api.get("/api/snapshot", (c) => c.json(getSnapshot()));

api.put("/api/snapshot", async (c) => {
  const body = snapshotSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid body" }, 400);
  setSnapshot(body.data);
  return c.json({ ok: true });
});
