import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { randomToken, safeEqual, sha256 } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import characterPath from "./assets/sparky-character.webp" with { type: "file" };

const character = `data:image/webp;base64,${Buffer.from(await Bun.file(characterPath).arrayBuffer()).toString("base64")}`;

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

interface Client {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
}

let failedLogins = 0;
let lockedUntil = 0;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function getClient(clientId: string | undefined): Client | null {
  if (!clientId) return null;
  const row = db.prepare("SELECT data FROM oauth_clients WHERE client_id = ?").get(clientId) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as Client) : null;
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function issueTokens(clientId: string) {
  const access = randomToken();
  const refresh = randomToken();
  const insert = db.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, expires_at) VALUES (?, ?, ?, ?)");
  const now = Date.now();
  insert.run(sha256(access), "access", clientId, now + ACCESS_TTL_MS);
  insert.run(sha256(refresh), "refresh", clientId, now + REFRESH_TTL_MS);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
  };
}

function consentPage(params: Record<string, string>, clientName: string, error?: string): string {
  const hidden = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("");
  return `<!doctype html>
<html lang="en" translate="no">
<head>
<meta charset="utf-8">
<meta name="google" content="notranslate">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>Authorize Sparky</title>
<style>
  :root { --bg:#ededed; --surface:#ffffff; --field:#f5f5f5; --border:#cccccc; --text:#000000; --muted:#666666; --accent:#006bff; --on-accent:#ffffff; --danger:#ef4444; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0d0d; --surface:#191919; --field:#0d0d0d; --border:#2d2d2d; --text:#ffffff; --muted:#a0a0a0; --danger:#ff5959; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text); font:16px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  main { width:100%; max-width:380px; background:var(--surface); border:1px solid var(--border); border-radius:24px; padding:28px 24px 24px; }
  .art { display:block; width:96px; height:96px; margin:0 auto 14px; }
  h1 { margin:0 0 6px; font-size:20px; font-weight:700; text-align:center; }
  .lead { margin:0 0 20px; color:var(--muted); font-size:14px; text-align:center; }
  .lead strong { color:var(--text); font-weight:600; }
  label { display:block; font-size:13px; font-weight:600; margin-bottom:6px; }
  input[type=password] { width:100%; padding:11px 16px; border:1px solid var(--border); border-radius:24px; background:var(--field); color:var(--text); font:inherit; }
  input[type=password]:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  button { margin-top:16px; width:100%; padding:11px; border:0; border-radius:24px; background:var(--accent); color:var(--on-accent); font:inherit; font-weight:600; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  button:active { filter:brightness(0.92); }
  .error { color:var(--danger); font-size:13px; margin:10px 0 0; }
  .note { margin:16px 0 0; color:var(--muted); font-size:12px; text-align:center; }
</style>
</head>
<body>
<main>
  <img class="art" src="${character}" alt="" width="96" height="96">
  <h1>Connect to Sparky</h1>
  <p class="lead"><strong>${escapeHtml(clientName)}</strong> wants to read and manage your Minds and Memories.</p>
  <form method="post" action="/authorize">
    ${hidden}
    <label for="password">Server password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <button type="submit">Authorize</button>
  </form>
  <p class="note">Only continue if you started this connection.</p>
</main>
</body>
</html>`;
}

export const oauth = new Hono();

const protectedResourceMetadata = (c: { json: (body: unknown) => Response }) =>
  c.json({
    resource: `${config.publicUrl}/mcp`,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ["header"],
  });

oauth.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
oauth.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

oauth.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/authorize`,
    token_endpoint: `${config.publicUrl}/token`,
    registration_endpoint: `${config.publicUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }),
);

oauth.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    client_name?: string;
    redirect_uris?: unknown;
  } | null;
  const uris = Array.isArray(body?.redirect_uris) ? (body!.redirect_uris as unknown[]) : [];
  if (!uris.length || !uris.every((uri): uri is string => typeof uri === "string" && isAllowedRedirect(uri))) {
    return c.json({ error: "invalid_redirect_uri" }, 400);
  }
  const client: Client = {
    client_id: randomUUID(),
    client_name: typeof body?.client_name === "string" ? body.client_name.slice(0, 100) : undefined,
    redirect_uris: uris,
  };
  db.prepare("INSERT INTO oauth_clients (client_id, data) VALUES (?, ?)").run(client.client_id, JSON.stringify(client));
  return c.json(
    {
      ...client,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
});

oauth.get("/authorize", (c) => {
  const q = c.req.query();
  const client = getClient(q.client_id);
  if (!client || !q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return c.text("Invalid client or redirect_uri", 400);
  }
  if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge) {
    return c.text("Unsupported authorization request (PKCE S256 required)", 400);
  }
  const params = {
    client_id: q.client_id!,
    redirect_uri: q.redirect_uri,
    code_challenge: q.code_challenge,
    state: q.state ?? "",
  };
  return c.html(consentPage(params, client.client_name ?? "An MCP client"));
});

oauth.post("/authorize", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string>;
  const client = getClient(form.client_id);
  if (!client || !form.redirect_uri || !client.redirect_uris.includes(form.redirect_uri) || !form.code_challenge) {
    return c.text("Invalid request", 400);
  }
  const params = {
    client_id: form.client_id!,
    redirect_uri: form.redirect_uri,
    code_challenge: form.code_challenge,
    state: form.state ?? "",
  };
  const clientName = client.client_name ?? "An MCP client";

  if (Date.now() < lockedUntil) {
    return c.html(consentPage(params, clientName, "Too many attempts. Try again later."), 429);
  }
  if (!form.password || !safeEqual(form.password, config.adminPassword)) {
    if (++failedLogins >= MAX_FAILED_LOGINS) {
      failedLogins = 0;
      lockedUntil = Date.now() + LOCKOUT_MS;
    }
    return c.html(consentPage(params, clientName, "Wrong password."), 401);
  }
  failedLogins = 0;

  const code = randomToken();
  db.prepare(
    "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sha256(code), client.client_id, form.redirect_uri, form.code_challenge, Date.now() + CODE_TTL_MS);

  const target = new URL(form.redirect_uri);
  target.searchParams.set("code", code);
  if (form.state) target.searchParams.set("state", form.state);
  return c.redirect(target.toString(), 302);
});

oauth.post("/token", async (c) => {
  const form = (await c.req.parseBody()) as Record<string, string>;
  const client = getClient(form.client_id);
  if (!client) return c.json({ error: "invalid_client" }, 401);

  if (form.grant_type === "authorization_code") {
    const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha256(form.code ?? "")) as
      | { client_id: string; redirect_uri: string; code_challenge: string; expires_at: number }
      | undefined;
    db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(sha256(form.code ?? ""));
    if (!row || row.expires_at < Date.now() || row.client_id !== client.client_id || row.redirect_uri !== form.redirect_uri) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    const challenge = createHash("sha256")
      .update(form.code_verifier ?? "")
      .digest("base64url");
    if (!form.code_verifier || !safeEqual(challenge, row.code_challenge)) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    return c.json(issueTokens(client.client_id));
  }

  if (form.grant_type === "refresh_token") {
    const hash = sha256(form.refresh_token ?? "");
    const row = db.prepare("SELECT client_id, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash) as
      | { client_id: string; expires_at: number }
      | undefined;
    db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(hash);
    if (!row || row.expires_at < Date.now() || row.client_id !== client.client_id) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(Date.now());
    return c.json(issueTokens(client.client_id));
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});
