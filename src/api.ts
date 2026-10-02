import { Hono } from "hono";
import { z } from "zod";
import { requireApiToken } from "./auth.js";
import { claimPending, reportResult } from "./commands.js";
import { setMirror } from "./mirror.js";
import { commandResultSchema, idSchema, mirrorSchema } from "./schema.js";

export const api = new Hono();
api.use("/api/*", requireApiToken);

api.put("/api/mirror", async (c) => {
  const body = mirrorSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid mirror.", issues: body.error.issues }, 400);
  setMirror(body.data);
  return c.json({ ok: true });
});

api.get("/api/commands", (c) => {
  const limit = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(c.req.query("limit") ?? 20);
  if (!limit.success) return c.json({ error: "limit must be a positive integer." }, 400);
  return c.json({ commands: claimPending(limit.data) });
});

api.post("/api/commands/:id/result", async (c) => {
  const id = idSchema.safeParse(c.req.param("id"));
  const body = commandResultSchema.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !body.success) return c.json({ error: "Invalid command result." }, 400);
  if (!reportResult(id.data, body.data.status, body.data.result, body.data.error)) {
    return c.json({ error: "Command not found." }, 404);
  }
  return c.json({ ok: true });
});
