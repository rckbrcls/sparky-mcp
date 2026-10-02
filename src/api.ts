import { Hono, type Context } from "hono";
import { z } from "zod";
import { formatApiFailure, type ApiFailureBody } from "./api-log.js";
import { requireApiToken } from "./auth.js";
import { claimPending, reportResult } from "./commands.js";
import { setMirror } from "./mirror.js";
import { commandResultSchema, idSchema, mirrorSchema } from "./schema.js";

function fail(c: Context, status: 400 | 404, body: ApiFailureBody & { error: string }) {
  console.error(formatApiFailure(c.req.method, c.req.path, status, body));
  return c.json(body, status);
}

export const api = new Hono();
api.use("/api/*", requireApiToken);

api.put("/api/mirror", async (c) => {
  const body = mirrorSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return fail(c, 400, { error: "Invalid mirror.", issues: body.error.issues });
  setMirror(body.data);
  return c.json({ ok: true });
});

api.get("/api/commands", (c) => {
  const limit = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(c.req.query("limit") ?? 20);
  if (!limit.success) return fail(c, 400, { error: "limit must be a positive integer." });
  return c.json({ commands: claimPending(limit.data) });
});

api.post("/api/commands/:id/result", async (c) => {
  const id = idSchema.safeParse(c.req.param("id"));
  const body = commandResultSchema.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !body.success) return fail(c, 400, { error: "Invalid command result." });
  if (!reportResult(id.data, body.data.status, body.data.result, body.data.error)) {
    return fail(c, 404, { error: "Command not found." });
  }
  return c.json({ ok: true });
});
