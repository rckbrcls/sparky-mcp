import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { config } from "./config.js";
import { db } from "./db.js";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function bearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function isValidOAuthAccessToken(token: string): boolean {
  const row = db
    .prepare("SELECT expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
    .get(sha256(token)) as { expires_at: number } | undefined;
  return !!row && row.expires_at > Date.now();
}

/** Routes used by the Sparky app: static API token only. */
export const requireApiToken: MiddlewareHandler = async (c, next) => {
  const token = bearer(c.req.header("authorization"));
  if (!token || !safeEqual(token, config.apiToken)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

/** MCP route: static API token (Claude Code, Codex) or OAuth access token (Claude, ChatGPT). */
export const requireMcpAuth: MiddlewareHandler = async (c, next) => {
  const token = bearer(c.req.header("authorization"));
  if (token && (safeEqual(token, config.apiToken) || isValidOAuthAccessToken(token))) {
    await next();
    return;
  }
  return c.json({ error: "unauthorized" }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`,
  });
};
