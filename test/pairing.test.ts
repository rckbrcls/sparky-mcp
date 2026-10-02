import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairingSchema } from "../src/pairing-schema.js";
import { CODE_ALPHABET, CODE_TTL_MS, cleanupPairing, createPairingApp, createPairingCode, generateCode, hashCode, normalizeCode, redeemCode } from "../src/pairing.js";
import { pair, type PairProbes } from "../src/cli/pair.js";

const token = "private-api-token";
const invalid = { error: "Invalid or expired code." };

function fixture() {
  const db = new Database(":memory:");
  db.exec(pairingSchema);
  let now = 1000000;
  const app = createPairingApp(db, token, () => now);
  return { db, app, now: () => now, advance: (ms: number) => { now += ms; } };
}

function redeem(app: Hono, code: unknown) {
  return app.request("/api/pair/redeem", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, extra: true }),
  });
}

test("codes use eight uniform alphabet draws and normalize input", () => {
  const limits: number[] = [];
  expect(generateCode((max) => { limits.push(max); return max - 1; })).toBe("9999-9999");
  expect(limits).toEqual(Array(8).fill(CODE_ALPHABET.length));
  for (let i = 0; i < 100; i++) {
    const code = generateCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeCode(code)?.length).toBe(8);
    expect([...code.replace("-", "")].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
  }
  expect(normalizeCode("  abcd - efgh  ")).toBe("ABCDEFGH");
  for (const value of ["IIII-OOOO", "AAAA-AAA1", "abc", "ABCDEFGH!", "ABCD\tEFGH"]) expect(normalizeCode(value)).toBeNull();
});

test("redeem returns configured token once with identical errors for used, expired, wrong and malformed", async () => {
  const f = fixture();
  try {
    const { code } = createPairingCode(f.db, f.now());
    const response = await redeem(f.app, code.toLowerCase().replace("-", " - "));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiToken: token });
    const used = await redeem(f.app, code);
    expect(used.status).toBe(401);
    expect(await used.json()).toEqual(invalid);
    const next = createPairingCode(f.db, f.now());
    f.advance(CODE_TTL_MS);
    for (const value of [next.code, "ZZZZ-ZZZZ", "IIII-OOOO"]) {
      const response = await redeem(f.app, value);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(invalid);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  } finally { f.db.close(); }
});

test("concurrent redemption on separate connections permits exactly one success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sparky-pair-race-"));
  const first = new Database(join(dir, "pair.db"));
  first.exec(pairingSchema);
  const second = new Database(join(dir, "pair.db"));
  try {
    const { code } = createPairingCode(first);
    const responses = await Promise.all([
      redeem(createPairingApp(first, token), code), redeem(createPairingApp(second, token), code),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("global lock persists across reopened database and does not consume correct code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sparky-pair-lock-"));
  let db = new Database(join(dir, "pair.db"));
  const now = 1000000;
  try {
    db.exec(pairingSchema);
    const { code, hash } = createPairingCode(db, now);
    const app = createPairingApp(db, token, () => now);
    for (let i = 0; i < 5; i++) {
      const response = await redeem(app, "bad");
      expect(response.status).toBe(i === 4 ? 429 : 401);
      if (i === 4) expect(response.headers.get("retry-after")).toBe("900");
    }
    db.close();
    db = new Database(join(dir, "pair.db"));
    const response = await redeem(createPairingApp(db, token, () => now + 1000), code);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("899");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Too many attempts. Try again later." });
    expect(db.query("SELECT used_at FROM pairing_codes WHERE code_hash = ?").get(hash)).toEqual({ used_at: null });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("success resets failures and lockout expires", async () => {
  const f = fixture();
  try {
    const { code } = createPairingCode(f.db, f.now());
    for (let i = 0; i < 4; i++) expect((await redeem(f.app, "bad")).status).toBe(401);
    expect((await redeem(f.app, code)).status).toBe(200);
    expect(f.db.query("SELECT failures, locked_until FROM pairing_lockout").get()).toEqual({ failures: 0, locked_until: 0 });
    for (let i = 0; i < 5; i++) await redeem(f.app, "bad");
    f.advance(15 * 60 * 1000);
    expect((await redeem(f.app, "bad")).status).toBe(401);
    expect(f.db.query("SELECT failures FROM pairing_lockout").get()).toEqual({ failures: 1 });
  } finally { f.db.close(); }
});

test("only hashes are stored and redeem never logs", async () => {
  const f = fixture();
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { code, hash } = createPairingCode(f.db, f.now());
    expect(f.db.query("SELECT * FROM pairing_codes").get()).toEqual({ code_hash: hashCode(normalizeCode(code)!), created_at: f.now(), expires_at: f.now() + CODE_TTL_MS, used_at: null });
    expect(JSON.stringify(f.db.query("SELECT * FROM pairing_codes").all())).not.toContain(code);
    await redeem(f.app, code);
    await redeem(f.app, code);
    await redeem(f.app, "bad");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(f.db.query("SELECT used_at FROM pairing_codes WHERE code_hash = ?").get(hash)).toEqual({ used_at: f.now() });
  } finally { log.mockRestore(); error.mockRestore(); f.db.close(); }
});

test("invalid JSON, missing code and oversized bodies return no-store request errors", async () => {
  const f = fixture();
  try {
    for (const [body, contentType] of [["not-json", "application/json"], ["{}", "application/json"], ['{"code":42}', "application/json"], [JSON.stringify({ code: "A".repeat(1024) }), "application/json"], ['{"code":"ABCDEFGH"}', "text/plain"]]) {
      const response = await f.app.request("/api/pair/redeem", { method: "POST", headers: { "Content-Type": contentType! }, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request." });
      expect(response.headers.get("cache-control")).toBe("no-store");
      f.db.exec("UPDATE pairing_lockout SET failures = 0, locked_until = 0");
    }
    const response = await f.app.request("/api/pair/redeem", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1025" }, body: "{}" });
    expect(response.status).toBe(400);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":"'));
        controller.enqueue(new Uint8Array(1024).fill(65));
        controller.close();
      },
    });
    const streamed = await f.app.request("/api/pair/redeem", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: stream,
    });
    expect(streamed.status).toBe(400);
    expect(streamed.headers.get("cache-control")).toBe("no-store");
  } finally { f.db.close(); }
});

function cliProbes(db: Database, overrides: Partial<PairProbes> = {}): PairProbes {
  return {
    config: () => ({ exists: true, data: "/unused", values: { PUBLIC_URL: "https://host.test", API_TOKEN: token } }),
    open: () => db, now: () => 1000000, random: () => 0, tty: true,
    sleep: async () => { throw new Error("Must not wait"); }, message: () => {}, ...overrides,
  };
}

test("CLI resets lockout, invalidates previous code and prints box without token", async () => {
  const db = new Database(":memory:");
  db.exec(pairingSchema);
  const previous = createPairingCode(db, 1000000, () => 1);
  db.exec("UPDATE pairing_lockout SET failures = 5, locked_until = 2000000");
  const messages: string[] = [];
  const close = spyOn(db, "close").mockImplementation(() => {});
  try {
    await pair({ noWait: true }, cliProbes(db, { message: (text) => { messages.push(text); } }));
    expect(messages.join("\n")).toContain("AAAA-AAAA");
    expect(messages.join("\n")).toContain("https://host.test");
    expect(messages.join("\n")).toContain("works once");
    expect(messages.join("\n")).not.toContain(token);
    expect(db.query("SELECT * FROM pairing_codes WHERE code_hash = ?").get(previous.hash)).toBeNull();
    expect(db.query("SELECT failures, locked_until FROM pairing_lockout").get()).toEqual({ failures: 0, locked_until: 0 });
    expect(close).toHaveBeenCalledTimes(1);
  } finally { close.mockRestore(); db.close(); }
});

test("CLI non-TTY returns immediately and missing config fails before opening DB", async () => {
  await pair({}, cliProbes(new Database(":memory:"), { tty: false }));
  const db = new Database(":memory:");
  try { await expect(pair({}, cliProbes(db, {
    config: () => ({ exists: false, data: "", values: {} }),
    open: () => { throw new Error("Must not open"); },
  }))).rejects.toThrow("Run sparky-mcp init first."); }
  finally { db.close(); }
});

test("CLI waits using injected DB and clock, reports paired, expiry and handles Ctrl+C", async () => {
  for (const outcome of ["paired", "expired", "cancelled"]) {
    const db = new Database(":memory:");
    const messages: string[] = [];
    let now = 1000000;
    const exitCode = process.exitCode;
    const listeners = process.listenerCount("SIGINT");
    try {
      await pair({}, cliProbes(db, {
        now: () => now, message: (text) => { messages.push(text); },
        sleep: async (ms) => {
          expect(ms).toBe(1000);
          if (outcome === "paired") {
            expect(redeemCode(db, "AAAA-AAAA", now).status).toBe(200);
            expect(redeemCode(db, "AAAA-AAAA", now).status).toBe(401);
          }
          else if (outcome === "expired") now += CODE_TTL_MS;
          else process.emit("SIGINT");
        },
      }));
      if (outcome === "paired") expect(messages.at(-1)).toBe("Paired. The app now has access.");
      if (outcome === "expired") {
        expect(messages.at(-1)).toBe("Code expired. Run sparky-mcp pair again.");
        expect(process.exitCode).toBe(1);
      }
      if (outcome === "cancelled") expect(messages).toHaveLength(1);
      expect(process.listenerCount("SIGINT")).toBe(listeners);
    } finally { process.exitCode = exitCode ?? 0; }
  }
});

test("maintenance cleans old rows while preserving recent use for CLI polling", () => {
  const f = fixture();
  try {
    createPairingCode(f.db, f.now());
    f.db.exec(`UPDATE pairing_codes SET used_at = ${f.now()}`);
    cleanupPairing(f.db, f.now() + 1000);
    expect(f.db.query("SELECT COUNT(*) AS count FROM pairing_codes").get()).toEqual({ count: 1 });
    f.advance(CODE_TTL_MS);
    cleanupPairing(f.db, f.now());
    expect(f.db.query("SELECT COUNT(*) AS count FROM pairing_codes").get()).toEqual({ count: 0 });
  } finally { f.db.close(); }
});

test("public pairing bypasses actual API auth while commands still require bearer token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sparky-pair-api-"));
  const names = ["PUBLIC_URL", "API_TOKEN", "ADMIN_PASSWORD", "DATA_DIR", "SPARKY_MCP_HOME"];
  const saved = names.map((name) => process.env[name]);
  let serverDb: Database | undefined;
  try {
    Object.assign(process.env, { PUBLIC_URL: "https://host.test", API_TOKEN: token, ADMIN_PASSWORD: "password", DATA_DIR: dir, SPARKY_MCP_HOME: dir });
    const { api } = await import("../src/api.js");
    serverDb = (await import("../src/db.js")).db;
    const app = new Hono();
    app.route("/", createPairingApp(serverDb, token));
    app.route("/", api);
    expect((await app.request("/api/commands")).status).toBe(401);
    const { code } = createPairingCode(serverDb);
    const response = await redeem(app, code);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiToken: token });
    expect((await app.request("/api/commands", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally {
    serverDb?.close();
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    rmSync(dir, { recursive: true, force: true });
  }
});
