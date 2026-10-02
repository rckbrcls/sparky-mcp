# sparky-mcp

Self-hosted [MCP](https://modelcontextprotocol.io) server for the [Sparky](https://github.com/rckbrcls/sparky) app. It lets Claude, ChatGPT, Claude Code or Codex create memories (reminders, notes, checklists) in your Sparky app, even when you are away from your Mac.

Everything is optional and per-user: you run your own server, and the app works exactly as before if you never configure it.

## How it works

```
Claude / ChatGPT / Claude Code / Codex
        │  MCP over HTTPS (OAuth or bearer token)
        ▼
   sparky-mcp  ──  SQLite mirror + command queue
        ▲
        │  Sparky uploads Minds and Memories to PUT /api/mirror.
        │  It claims commands from GET /api/commands, applies them locally,
        │  and reports results to POST /api/commands/:id/result.
```

The app owns the data. The server answers reads from the mirror and queues writes; the app applies commands in order and re-uploads the mirror. Changes queued while the app is closed are applied when it opens. Read results include `syncedAt` and `stale: true` when the mirror is older than 24 hours.

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
| `list_minds` | Synced Mind tree with IDs, names, colors, icons, and parents. |
| `list_memories` | Memory summaries filtered by mind, status, pinned state, due dates, text, and limit (default 50). |
| `get_memory` | Full Memory by UUID. |
| `get_command_status` | Command state, result, and error by UUID. |
| `create_memory` | Queues a Memory with note, mind, pin, priority, due date, checklist, schedule, location, and links. |
| `update_memory` | Queues a Memory patch; checklist replaces the entire list. |
| `set_memory_status` | Queues active/completed status, optionally for one recurring occurrence. |
| `toggle_check_item` | Queues toggling a checklist item, optionally for one recurring occurrence. |
| `delete_memory` | Queues deletion; requires `confirm: true`. |
| `create_mind` | Queues a Mind folder. |
| `update_mind` | Queues a Mind patch. |
| `delete_mind` | Queues recursive Mind deletion; memories move to the Inbox. Requires `confirm: true`. |

Write tools return `{ commandId, status: "pending" }`. Mind names are resolved case-insensitively; unknown minds and targets absent from the mirror are rejected. Updates, status changes, checklist toggles, and deletions default `baseVersion` to the mirror entity's `updatedAt`; clients may override it. Dates accept ISO 8601 with UTC offsets and are normalized to UTC. Null clears nullable patch fields; absent keys leave fields unchanged.

## App API

All routes require `Authorization: Bearer <API_TOKEN>`.

| Route | Description |
| --- | --- |
| `PUT /api/mirror` | Full replace of `{ syncedAt, minds: [Mind], memories: [Memory] }`; returns `{ ok: true }`. |
| `GET /api/commands?limit=20` | Atomically claims pending commands oldest first; returns `{ commands: [{ id, type, targetId, baseVersion, payload, createdAt }] }`. |
| `POST /api/commands/:id/result` | Reports `{ status: "done" / "failed" / "conflict", result: object, error: string }`; returns `{ ok: true }`. Repeat reports do not change finished commands. |

The app applies commands one at a time in creation order and remembers their IDs to avoid re-execution. Claims older than five minutes return to pending on the next poll. Finished commands are purged on startup and hourly after 30 days. See [docs/CONTRACT.md](docs/CONTRACT.md) for complete entity and command shapes.

## Security notes

- The `/mcp` endpoint is public when exposed through Funnel. Use a long random `API_TOKEN` and a strong `ADMIN_PASSWORD`; consent attempts lock out for 15 minutes after 5 failures.
- OAuth uses dynamic client registration with PKCE (S256) and public clients. Access tokens last 1 hour, refresh tokens 90 days (rotated on use); only hashes are stored.
- Data lives in `DATA_DIR/sparky-mcp.db` (SQLite). Back it up if you care about pending items.
