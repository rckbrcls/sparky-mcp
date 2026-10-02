import { createHash, randomBytes, randomUUID } from "node:crypto";

type Json = Record<string, unknown>;
interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}
interface Tokens {
  access_token: string;
  refresh_token: string;
}

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const apiToken = process.env.SMOKE_API_TOKEN;
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD;
let failed = 0;
let requestId = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function check<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await action();
    console.log(`PASS ${label}`);
    return result;
  } catch (error) {
    failed++;
    let message = error instanceof Error ? error.message : "Check failed.";
    for (const secret of [apiToken, adminPassword]) {
      if (secret) message = message.split(secret).join("[redacted]");
    }
    console.error(`FAIL ${label}: ${message}`);
    return undefined;
  }
}

function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

function authorizedHeaders(token = apiToken): Record<string, string> {
  assert(token, "Set SMOKE_API_TOKEN.");
  return { Authorization: `Bearer ${token}` };
}

async function jsonResponse(response: Response, status = 200): Promise<Json> {
  assert(response.status === status, `Expected HTTP ${status}, received ${response.status}.`);
  return await response.json() as Json;
}

async function rpc(method: string, params: Json = {}, token = apiToken): Promise<unknown> {
  const body = await jsonResponse(await request("/mcp", {
    method: "POST",
    headers: {
      ...authorizedHeaders(token),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  }));
  assert(!body.error, `MCP ${method} returned an error.`);
  assert("result" in body, `MCP ${method} returned no result.`);
  return body.result;
}

async function callTool(name: string, args: Json = {}, token = apiToken): Promise<ToolResult> {
  return await rpc("tools/call", { name, arguments: args }, token) as ToolResult;
}

function toolData(result: ToolResult): Json {
  assert(!result.isError, "Tool returned isError.");
  const content = result.content.find((item) => item.type === "text");
  assert(content?.text, "Tool returned no text content.");
  return JSON.parse(content.text) as Json;
}

function tokenRequest(params: Record<string, string>) {
  return request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

function tokens(body: Json): Tokens {
  assert(typeof body.access_token === "string" && body.access_token.length, "Access token missing.");
  assert(typeof body.refresh_token === "string" && body.refresh_token.length, "Refresh token missing.");
  assert(body.token_type === "Bearer", "Token type must be Bearer.");
  return { access_token: body.access_token, refresh_token: body.refresh_token };
}

await check("Health", async () => {
  const body = await jsonResponse(await request("/health"));
  assert(body.ok === true, "Health response is not ok.");
});

await check("Commands reject missing token", async () => {
  const response = await request("/api/commands");
  assert(response.status === 401, `Expected HTTP 401, received ${response.status}.`);
});

await check("Commands accept API token", async () => {
  const body = await jsonResponse(await request("/api/commands", { headers: authorizedHeaders() }));
  assert(Array.isArray(body.commands), "Commands response is not an array.");
});

await check("MCP rejects missing token", async () => {
  const response = await request("/mcp", { headers: { Accept: "application/json, text/event-stream" } });
  assert(response.status === 401, `Expected HTTP 401, received ${response.status}.`);
});

const mindId = randomUUID();
await check("Upload mirror", async () => {
  const now = new Date().toISOString();
  const body = await jsonResponse(await request("/api/mirror", {
    method: "PUT",
    headers: { ...authorizedHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      syncedAt: now,
      minds: [{
        id: mindId, name: "Smoke", colorHex: null, iconName: null, sortOrder: 0,
        parentId: null, isDefault: false, updatedAt: now,
      }],
      memories: [],
    }),
  }));
  assert(body.ok === true, "Mirror upload was not acknowledged.");
});

await check("MCP initialize", async () => {
  const body = await rpc("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sparky-smoke", version: "1.0.0" },
  }) as Json;
  assert(typeof body.protocolVersion === "string" && body.serverInfo, "Initialization response is incomplete.");
});

await check("MCP lists 13 tools", async () => {
  const body = await rpc("tools/list") as Json;
  assert(Array.isArray(body.tools) && body.tools.length === 13, "Expected exactly 13 tools.");
});

await check("list_minds reads mirror", async () => {
  const body = toolData(await callTool("list_minds"));
  assert(Array.isArray(body.minds), "Mind tree missing.");
  assert(body.minds.some((mind: Json) => mind.id === mindId && mind.name === "Smoke"), "Uploaded mind missing.");
});

const commandId = await check("create_memory queues command", async () => {
  const body = toolData(await callTool("create_memory", { title: "Smoke memory", mind: mindId }));
  assert(body.status === "pending" && typeof body.commandId === "string", "Expected a pending command ID.");
  return body.commandId;
});

await check("Command claimed once", async () => {
  assert(commandId, "Memory creation failed.");
  const body = await jsonResponse(await request("/api/commands", { headers: authorizedHeaders() }));
  assert(Array.isArray(body.commands), "Commands response missing.");
  const command = body.commands.find((item: Json) => item.id === commandId) as Json | undefined;
  assert(command?.type === "memory.create", "Queued memory command missing.");
  const payload = command.payload as Json;
  assert(payload.title === "Smoke memory" && payload.mindId === mindId, "Command payload differs from tool input.");
});

await check("Second command poll is empty", async () => {
  assert(commandId, "Memory creation failed.");
  const body = await jsonResponse(await request("/api/commands", { headers: authorizedHeaders() }));
  assert(Array.isArray(body.commands) && body.commands.length === 0, "Second poll must be empty.");
});

await check("Report command done", async () => {
  assert(commandId, "Memory creation failed.");
  const body = await jsonResponse(await request(`/api/commands/${commandId}/result`, {
    method: "POST",
    headers: { ...authorizedHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ status: "done", result: { id: randomUUID() } }),
  }));
  assert(body.ok === true, "Command result was not acknowledged.");
});

await check("get_command_status returns done", async () => {
  assert(commandId, "Memory creation failed.");
  const body = toolData(await callTool("get_command_status", { id: commandId }));
  assert((body.command as Json)?.status === "done", "Command is not done.");
});

await check("Unknown memory returns isError", async () => {
  const body = await callTool("get_memory", { id: randomUUID() });
  assert(body.isError === true, "Unknown memory did not return isError.");
});

await check("OAuth metadata", async () => {
  const resource = await jsonResponse(await request("/.well-known/oauth-protected-resource/mcp"));
  const server = await jsonResponse(await request("/.well-known/oauth-authorization-server"));
  assert(typeof resource.resource === "string" && resource.resource.endsWith("/mcp"), "Protected resource missing.");
  assert(Array.isArray(resource.authorization_servers) && resource.authorization_servers.includes(server.issuer), "Authorization issuer mismatch.");
  assert(Array.isArray(server.code_challenge_methods_supported) && server.code_challenge_methods_supported.includes("S256"), "PKCE S256 missing.");
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    assert(typeof server[key] === "string", `Metadata ${key} missing.`);
  }
});

const redirectUri = "http://127.0.0.1:9876/callback";
const clientId = await check("OAuth client registration", async () => {
  const body = await jsonResponse(await request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Sparky smoke", redirect_uris: [redirectUri] }),
  }), 201);
  assert(typeof body.client_id === "string" && body.client_id.length, "Client ID missing.");
  return body.client_id;
});

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomUUID();
function authorizationParams() {
  assert(clientId, "Client registration failed.");
  return { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, state };
}

await check("OAuth authorize page", async () => {
  const query = new URLSearchParams({ ...authorizationParams(), response_type: "code", code_challenge_method: "S256" });
  const response = await request(`/authorize?${query}`);
  assert(response.status === 200, `Expected HTTP 200, received ${response.status}.`);
  const html = await response.text();
  assert(html.includes('name="password"') && html.includes('name="code_challenge"'), "Authorization form missing.");
});

await check("OAuth rejects wrong password", async () => {
  const response = await request("/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...authorizationParams(), password: `wrong-${randomUUID()}` }),
  });
  assert(response.status === 401, `Expected HTTP 401, received ${response.status}.`);
});

const code = await check("OAuth correct password redirects with code", async () => {
  assert(adminPassword, "Set SMOKE_ADMIN_PASSWORD.");
  const response = await request("/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...authorizationParams(), password: adminPassword }),
  });
  assert(response.status === 302, `Expected HTTP 302, received ${response.status}.`);
  const location = response.headers.get("location");
  assert(location, "Redirect location missing.");
  const url = new URL(location);
  assert(url.origin === new URL(redirectUri).origin && url.pathname === "/callback", "Redirect URI mismatch.");
  assert(url.searchParams.get("state") === state, "OAuth state mismatch.");
  const code = url.searchParams.get("code");
  assert(code, "Authorization code missing.");
  return code;
});

const issued = await check("OAuth PKCE S256 token exchange", async () => {
  assert(clientId && code, "Authorization failed.");
  return tokens(await jsonResponse(await tokenRequest({
    grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier,
  })));
});

await check("MCP accepts OAuth access token", async () => {
  assert(issued, "Token exchange failed.");
  const body = await rpc("tools/list", {}, issued.access_token) as Json;
  assert(Array.isArray(body.tools) && body.tools.length === 13, "OAuth-authenticated tools missing.");
});

await check("OAuth refresh rotates tokens", async () => {
  assert(clientId && issued, "Token exchange failed.");
  const rotated = tokens(await jsonResponse(await tokenRequest({
    grant_type: "refresh_token", client_id: clientId, refresh_token: issued.refresh_token,
  })));
  assert(rotated.refresh_token !== issued.refresh_token && rotated.access_token !== issued.access_token, "Tokens were not rotated.");
  const body = await rpc("tools/list", {}, rotated.access_token) as Json;
  assert(Array.isArray(body.tools) && body.tools.length === 13, "Rotated access token failed.");
});

await check("OAuth rejects old refresh token", async () => {
  assert(clientId && issued, "Token exchange failed.");
  const body = await jsonResponse(await tokenRequest({
    grant_type: "refresh_token", client_id: clientId, refresh_token: issued.refresh_token,
  }), 400);
  assert(body.error === "invalid_grant", "Old refresh token was not rejected.");
});

console.log(`${failed ? "FAIL" : "PASS"} Smoke checks complete (${failed} failed).`);
process.exitCode = failed ? 1 : 0;
