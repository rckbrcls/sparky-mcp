import { createHash, randomInt } from "node:crypto";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_TTL_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

export const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

export function generateCode(random: (max: number) => number = randomInt): string {
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[random(CODE_ALPHABET.length)]!).join("");
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeCode(value: string): string | null {
  const code = value.trim().toUpperCase().replace(/[ -]/g, "");
  return /^[A-Z2-9]{8}$/.test(code) && [...code].every((ch) => CODE_ALPHABET.includes(ch)) ? code : null;
}

export function cleanupPairing(db: Database, now = Date.now()): void {
  db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ? OR used_at <= ?").run(now, now - CODE_TTL_MS);
}

export function createPairingCode(db: Database, now = Date.now(), random: (max: number) => number = randomInt) {
  const code = generateCode(random);
  const hash = hashCode(normalizeCode(code)!);
  const expiresAt = now + CODE_TTL_MS;
  db.transaction(() => {
    cleanupPairing(db, now);
    db.exec("DELETE FROM pairing_codes WHERE used_at IS NULL");
    db.exec("UPDATE pairing_lockout SET failures = 0, locked_until = 0 WHERE id = 1");
    db.prepare("INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(hash, now, expiresAt);
  }).immediate();
  return { code, hash, expiresAt };
}

type RedeemResult = { status: 200 | 401 | 400 } | { status: 429; retryAfter: number };

export function redeemCode(db: Database, value: string | null, now = Date.now()): RedeemResult {
  return db.transaction((): RedeemResult => {
    cleanupPairing(db, now);
    const state = db.prepare("SELECT failures, locked_until FROM pairing_lockout WHERE id = 1").get() as { failures: number; locked_until: number };
    if (state.locked_until > now) return { status: 429, retryAfter: Math.ceil((state.locked_until - now) / 1000) };
    const code = value === null ? null : normalizeCode(value);
    const row = code ? db.prepare("SELECT code_hash FROM pairing_codes WHERE code_hash = ? AND expires_at > ? AND used_at IS NULL").get(hashCode(code), now) as { code_hash: string } | null : null;
    if (row) {
      db.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?").run(now, row.code_hash);
      db.exec("UPDATE pairing_lockout SET failures = 0, locked_until = 0 WHERE id = 1");
      return { status: 200 };
    }
    const failures = (state.locked_until ? 0 : state.failures) + 1;
    const lockedUntil = failures >= 5 ? now + LOCKOUT_MS : 0;
    db.prepare("UPDATE pairing_lockout SET failures = ?, locked_until = ? WHERE id = 1").run(failures, lockedUntil);
    return lockedUntil ? { status: 429, retryAfter: LOCKOUT_MS / 1000 } : { status: value === null ? 400 : 401 };
  }).immediate();
}

async function requestCode(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > 1024) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return body && typeof body.code === "string" ? body.code : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export function createPairingApp(db: Database, apiToken: string, now: () => number = Date.now) {
  const app = new Hono();
  app.use("/api/pair/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.post("/api/pair/redeem", async (c) => {
    const result = redeemCode(db, await requestCode(c.req.raw), now());
    if (result.status === 429) {
      c.header("Retry-After", String(result.retryAfter));
      return c.json({ error: "Too many attempts. Try again later." }, 429);
    }
    if (result.status === 400) return c.json({ error: "Invalid request." }, 400);
    if (result.status === 401) return c.json({ error: "Invalid or expired code." }, 401);
    return c.json({ apiToken });
  });
  return app;
}
