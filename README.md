# sparky-mcp

Self-hosted [MCP](https://modelcontextprotocol.io) server for the [Sparky](https://github.com/rckbrcls/sparky) app. It lets Claude, ChatGPT, Claude Code or Codex create memories (reminders, notes, checklists) in your Sparky app, even when you are away from your Mac.

Everything is optional and per-user: you run your own server, and the app works exactly as before if you never configure it.

## How it works

```
Claude / ChatGPT / Claude Code / Codex
        │  MCP over HTTPS (OAuth or bearer token)
        ▼
   sparky-mcp  ──  SQLite inbox (pending memories)
        ▲
        │  Sparky app polls /api/inbox, creates the memories locally,
        │  then acknowledges them. It also pushes your Minds/Tags to /api/snapshot.
```

The server never touches your SwiftData store. It only queues items; the app imports them the next time it syncs. A memory created while the app is closed shows up when the app opens.

## Run it

```bash
cp .env.example .env     # fill PUBLIC_URL, API_TOKEN, ADMIN_PASSWORD
docker compose up -d --build
```

Without Docker (Node >= 22.13):

```bash
npm install
npm run dev               # or: npm run build && npm start
```

### Configuration

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public HTTPS URL of the server, no trailing slash. Used in OAuth metadata. |
| `API_TOKEN` | Bearer token for the Sparky app and local MCP clients. `openssl rand -hex 32` |
| `ADMIN_PASSWORD` | Password on the consent page when you add the connector in Claude/ChatGPT. |
| `USER_TIMEZONE` | Time zone reported by `get_current_time` (default: system). |
| `PORT`, `DATA_DIR` | Optional (defaults: `8787`, `./data`). |

## Expose it with Tailscale

Claude and ChatGPT call your server from their own cloud, so it needs a public HTTPS URL. With [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (HTTPS and MagicDNS enabled on your tailnet):

```bash
tailscale funnel --bg 8787
```

Set `PUBLIC_URL` to the `https://<host>.<tailnet>.ts.net` address it prints. The Sparky app and local clients (Claude Code, Codex) can use the same URL, or the private tailnet address without Funnel.

## Connect a client

- **Claude (web/desktop/mobile):** Settings → Connectors → add custom connector → `PUBLIC_URL/mcp`. Sign in with `ADMIN_PASSWORD` on the consent page.
- **ChatGPT:** enable developer mode, add a connector with `PUBLIC_URL/mcp`, same OAuth flow.
- **Claude Code:**
  ```bash
  claude mcp add --transport http sparky PUBLIC_URL/mcp --header "Authorization: Bearer $API_TOKEN"
  ```
- **Codex:** add an HTTP MCP server pointing to `PUBLIC_URL/mcp` with the same bearer header.

Client UIs change often; check each product's current documentation for remote MCP connectors and plan requirements.

## MCP tools

| Tool | Description |
| --- | --- |
| `get_current_time` | Current time and user time zone, for resolving "tomorrow at 9". |
| `list_minds` / `list_tags` | Names synced from the app. |
| `create_memory` | Queues a memory: title, note, mind, pin, `fireDate`, recurrence, location trigger, checklist. |

## App API

All routes require `Authorization: Bearer <API_TOKEN>`.

| Route | Description |
| --- | --- |
| `GET /api/inbox` | Pending items: `{ items: [{ id, createdAt, mindId, memory }] }`. |
| `POST /api/inbox/ack` | `{ ids: [...] }` marks items as imported (idempotent). |
| `PUT /api/snapshot` | `{ minds: [{ id, name, parentId }], tags: [{ id, name }] }`. |
| `GET /api/snapshot` | Current snapshot. |

Items carry a stable `id`; the app should dedupe on it in case an acknowledgement is lost.

## Security notes

- The `/mcp` endpoint is public when exposed through Funnel. Use a long random `API_TOKEN` and a strong `ADMIN_PASSWORD`; consent attempts lock out for 15 minutes after 5 failures.
- OAuth uses dynamic client registration with PKCE (S256) and public clients. Access tokens last 1 hour, refresh tokens 90 days (rotated on use); only hashes are stored.
- Data lives in `DATA_DIR/sparky-mcp.db` (SQLite). Back it up if you care about pending items.
