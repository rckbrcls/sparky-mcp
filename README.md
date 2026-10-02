# sparky-mcp

Self-hosted [MCP](https://modelcontextprotocol.io) server for the [Sparky](https://github.com/rckbrcls/sparky) Mac app. It lets Claude, ChatGPT, Claude Code, or Codex read and manage your Minds and Memories (reminders, notes, checklists), even when you are away from your Mac.

It is optional and per-user: you run your own server, nothing is hosted for you, and Sparky works exactly as before if you never set it up.

## Quick start

On the machine that will run the server (your Mac, a home server, or a VPS), with [Tailscale](https://tailscale.com) installed and signed in:

```bash
curl -fsSL https://raw.githubusercontent.com/rckbrcls/sparky-mcp/main/install.sh | sh
sparky-mcp setup
```

`sparky-mcp` is a single binary for Linux (x64/arm64) and macOS (Apple Silicon/Intel): it is the server and the command line tool. `setup` is a guided, repeatable wizard that configures everything, starts the service, optionally turns on public access, and connects the Sparky app and your AI clients. Run `sparky-mcp` with no arguments any time for a status summary and the suggested next step, and `sparky-mcp help <command>` for flags and examples.

The full walkthrough (requirements, what each step does, connecting the app and every AI client, operating, troubleshooting, migrating from the old Docker install) is in the [guide](docs/GUIDE.md).

## Commands

| Command | Purpose |
| --- | --- |
| `setup` | Guided first-time setup (config, service, Funnel, pairing, clients). |
| `init`, `start`, `stop`, `restart`, `status`, `logs` | Configure and manage the background service. |
| `pair` | Print a one-time code to connect the Sparky app without copying the token. |
| `connect` | Register Claude Code or Codex, or walk through the Claude and ChatGPT connectors (`claude-code`, `codex`, `claude-web`, `chatgpt`). |
| `funnel` | Turn public access on or off (`on`, `off`, `status`). |
| `info` | Show the connector URL and masked secrets (`--reveal`, `--copy token\|password`). |
| `doctor` | Diagnose config, service, Tailscale, Funnel, and app sync (`--fix` repairs the safe issues). |
| `update` | Install the latest release (checksum verified). |
| `serve` | Run the server in the foreground. |

Everything `setup` does is also available as an individual command.

## Configuration

`sparky-mcp init` (run by `setup`) writes `~/.sparky-mcp/config.env` (mode 0600). Set `SPARKY_MCP_HOME` to use another directory. Real environment variables override the file.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public HTTPS URL of the server, no trailing slash. Used in OAuth metadata. |
| `API_TOKEN` | Bearer token for the Sparky app and local MCP clients. |
| `ADMIN_PASSWORD` | Password on the consent page when you add the connector in Claude/ChatGPT. |
| `USER_TIMEZONE` | Time zone reported by `get_current_time` (default: system). |
| `PORT`, `DATA_DIR` | Optional (defaults: `8787`, `~/.sparky-mcp/data`). |

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

All routes require `Authorization: Bearer <API_TOKEN>`, except `POST /api/pair/redeem`, which is public and rate limited.

| Route | Description |
| --- | --- |
| `PUT /api/mirror` | Full replace of `{ syncedAt, minds: [Mind], memories: [Memory] }`; returns `{ ok: true }`. |
| `GET /api/commands?limit=20` | Atomically claims pending commands oldest first; returns `{ commands: [{ id, type, targetId, baseVersion, payload, createdAt }] }`. |
| `POST /api/commands/:id/result` | Reports `{ status: "done" / "failed" / "conflict", result: object, error: string }`; returns `{ ok: true }`. Repeat reports do not change finished commands. |
| `POST /api/pair/redeem` | Public. Exchanges a one-time pairing code `{ code }` for `{ apiToken }`. Wrong, expired, or used codes return 401; five failures lock it for 15 minutes (429 with `Retry-After`). |

The app applies commands one at a time in creation order and remembers their IDs to avoid re-execution. Claims older than five minutes return to pending on the next poll. Finished commands are purged on startup and hourly after 30 days. See [docs/CONTRACT.md](docs/CONTRACT.md) for complete entity and command shapes.

## Security

- Anyone with the API token can read and change your Minds and Memories. Treat it like a password; `config.env` is created with mode 0600 and `doctor` warns if that changes.
- The installer and `update` verify SHA-256 checksums before installing or replacing the binary.
- With Funnel, `/mcp` and `/api` are public. The consent page and pairing lock out for 15 minutes after 5 failed attempts.
- Pairing codes are stored hashed, expire in 5 minutes, and work once.
- OAuth tokens are hashed at rest; access tokens last 1 hour and refresh tokens 90 days.
- Data lives in `DATA_DIR/sparky-mcp.db` (SQLite). Back it up if you care about pending items.

## Develop

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run typecheck
bun test
bun run build            # compiles dist/sparky-mcp
```
