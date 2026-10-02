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

## Install and run

```bash
curl -fsSL https://raw.githubusercontent.com/rckbrcls/sparky-mcp/main/install.sh | sh
sparky-mcp init          # creates ~/.sparky-mcp with generated secrets
sparky-mcp start         # installs and starts a user service
sudo tailscale funnel --bg 8787
sparky-mcp doctor        # checks everything and tells you what to fix
```

`sparky-mcp` is a single binary for Linux (x64/arm64) and macOS (Apple Silicon/Intel). It is both the server and the CLI. Full walkthrough, including a VPS or cloud VM: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

| Command | Purpose |
| --- | --- |
| `init` | Create the config and generate the API token and admin password. |
| `start`, `stop`, `restart`, `status`, `logs` | Manage the background service. |
| `info` | Show the connector URL and masked secrets (`--reveal`, `--copy token\|password`). |
| `doctor` | Diagnose config, service, Tailscale, Funnel, and app sync. |
| `update` | Install the latest release (checksum verified). |
| `serve` | Run the server in the foreground. |

### Configuration

`sparky-mcp init` writes `~/.sparky-mcp/config.env` (mode 0600). Set `SPARKY_MCP_HOME` to use another directory. Real environment variables override the file.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public HTTPS URL of the server, no trailing slash. Used in OAuth metadata. |
| `API_TOKEN` | Bearer token for the Sparky app and local MCP clients. |
| `ADMIN_PASSWORD` | Password on the consent page when you add the connector in Claude/ChatGPT. |
| `USER_TIMEZONE` | Time zone reported by `get_current_time` (default: system). |
| `PORT`, `DATA_DIR` | Optional (defaults: `8787`, `~/.sparky-mcp/data`). |

### Develop

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run typecheck
bun test
bun run build            # compiles dist/sparky-mcp
```

## Expose it with Tailscale

Claude and ChatGPT call your server from their own cloud, so it needs a public HTTPS URL. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) provides one (enable HTTPS and MagicDNS on your tailnet):

```bash
sudo tailscale funnel --bg 8787
```

`sparky-mcp init` detects the `https://<host>.<tailnet>.ts.net` address and uses it as `PUBLIC_URL`. The Sparky app and local clients (Claude Code, Codex) use the same URL. Funnel makes `/mcp` and `/api` public: keep the generated secrets private.

## Connect a client

- **Claude (web/desktop/mobile):** Settings → Connectors → add custom connector → `PUBLIC_URL/mcp`. Sign in with `ADMIN_PASSWORD` on the consent page.
- **ChatGPT:** enable developer mode, add a connector with `PUBLIC_URL/mcp`, same OAuth flow.
- **Claude Code:**
  ```bash
  claude mcp add --scope user --transport http sparky PUBLIC_URL/mcp --header "Authorization: Bearer $API_TOKEN"
  ```
- **Codex:** `codex mcp add sparky --url PUBLIC_URL/mcp --bearer-token-env-var SPARKY_MCP_TOKEN` (export your `API_TOKEN` as `SPARKY_MCP_TOKEN` first).

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
