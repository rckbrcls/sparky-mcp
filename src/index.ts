import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { api } from "./api.js";
import { requireMcpAuth } from "./auth.js";
import { startCommandMaintenance } from "./commands.js";
import { config } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { oauth } from "./oauth.js";

startCommandMaintenance();

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", oauth);
app.route("/", api);

app.all("/mcp", requireMcpAuth, async (c) => {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`sparky-mcp listening on :${port} (public URL: ${config.publicUrl})`);
});
