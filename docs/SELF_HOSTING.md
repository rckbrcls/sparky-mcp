# Self-hosting guide

This guide takes you from a clean machine to Claude, ChatGPT, Claude Code, or Codex creating reminders in your Sparky app. Everything runs on hardware you own; nothing is hosted for you.

You need:

- A machine that stays on (a homelab box, mini PC, NAS, or a Mac) with Docker and Docker Compose.
- A free [Tailscale](https://tailscale.com) account with the machine and your Mac/iPhone on the same tailnet.
- The Sparky app (iOS 26 / macOS 26) with the Remote MCP section in Settings > Advanced.

## 1. Get the code and configure it

```bash
git clone https://github.com/rckbrcls/sparky-mcp.git
cd sparky-mcp
cp .env.example .env
```

Edit `.env`:

| Variable | What to put |
| --- | --- |
| `PUBLIC_URL` | The HTTPS address from step 3, e.g. `https://homelab.tail1234.ts.net`. No trailing slash. |
| `API_TOKEN` | A long random secret: `openssl rand -hex 32`. Used by the app, Claude Code, and Codex. |
| `ADMIN_PASSWORD` | A strong password. Only asked on the consent page when you add the Claude/ChatGPT connector. |
| `USER_TIMEZONE` | Your IANA zone, e.g. `America/Sao_Paulo`. Used to resolve "tomorrow at 9". |

Keep `.env` private (`chmod 600 .env`). It is gitignored.

If you do not know the Tailscale address yet, finish step 3 first and come back; the server refuses to start without `PUBLIC_URL`.

## 2. Run it with Docker

```bash
docker compose up -d --build
docker compose logs -f
```

You should see `sparky-mcp listening on :8787`. Data lives in the `sparky-mcp-data` volume (SQLite). The container publishes only on `127.0.0.1:8787`, so it is not reachable from the network until you expose it in step 3.

Check it locally:

```bash
curl -i http://127.0.0.1:8787/api/commands                                   # 401 without a token
curl -s -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8787/api/commands  # {"commands":[]}
```

Without Docker (Node >= 22.13): `npm install && npm run build && npm start`.

## 3. Expose it with Tailscale

Enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page). Then pick one:

**Private (tailnet only).** Enough for the Sparky app, Claude Code, and Codex on your own devices:

```bash
tailscale serve --bg 8787
```

**Public (Funnel).** Required for Claude and ChatGPT connectors, because they call your server from their own cloud:

```bash
tailscale funnel --bg 8787
```

Funnel must be allowed for the machine in your tailnet policy (Tailscale prints the link to enable it if it is not). Either command prints your `https://<host>.<tailnet>.ts.net` address. Put it in `PUBLIC_URL`, then apply it:

```bash
docker compose up -d
```

Verify from outside your network (for example on your phone's mobile data): `https://<host>.<tailnet>.ts.net/api/commands` should answer `401`.

Use the HTTPS address in the Sparky app too. iOS blocks plain `http://` URLs.

## 4. Connect the Sparky app

1. Open Sparky > Settings > Advanced > Remote MCP.
2. Enter the Server URL (your `PUBLIC_URL`) and the API token.
3. Turn the toggle on and tap Test connection, then Sync now.

Sync behavior: macOS keeps syncing in the background; iOS syncs only while the app is active. Commands queued while the app is closed are applied the next time it syncs.

## 5. Connect an AI client

Replace `PUBLIC_URL` with your address.

**Claude Code**

```bash
claude mcp add --scope user --transport http sparky PUBLIC_URL/mcp \
  --header "Authorization: Bearer $API_TOKEN"
```

Restart the Claude Code session so the tools load.

**Codex**

```bash
export SPARKY_MCP_TOKEN=<your API_TOKEN>      # keep it in your shell profile
codex mcp add sparky --url PUBLIC_URL/mcp --bearer-token-env-var SPARKY_MCP_TOKEN
```

**Claude (web, desktop, mobile)**: Settings > Connectors > Add custom connector > URL `PUBLIC_URL/mcp`. Claude opens the consent page; enter `ADMIN_PASSWORD`. Requires Funnel (step 3).

**ChatGPT**: enable developer mode, add a connector with `PUBLIC_URL/mcp`, and complete the same consent flow. Requires Funnel.

Product UIs and plan requirements change; check each vendor's current remote MCP documentation. The OAuth connectors (Claude, ChatGPT) are implemented but have not been exercised end to end yet; the bearer-token path (app, Claude Code) has.

Try it: ask "list my minds", then "remind me to call the dentist tomorrow at 9". The reply contains a `commandId`; the app applies it within about 10 seconds. `get_command_status` shows `done`, `failed`, or `conflict`.

## 6. Operate it

**Update**

```bash
git pull
docker compose up -d --build
```

**Back up** the SQLite data (pending commands and OAuth registrations):

```bash
docker run --rm -v sparky-mcp-data:/data -v "$PWD":/backup node:24-slim \
  tar czf /backup/sparky-mcp-data.tgz -C /data .
```

The notes and reminders themselves live in the app; the server only holds a mirror and a queue.

**Rotate secrets**: change `API_TOKEN` or `ADMIN_PASSWORD` in `.env`, run `docker compose up -d`, then update the token in the Sparky app and your clients.

**Stop sharing publicly**: `tailscale funnel reset` (or `tailscale serve reset`).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server exits at startup | `docker compose logs`; a required variable (`PUBLIC_URL`, `API_TOKEN`, `ADMIN_PASSWORD`) is missing. |
| App says unauthorized | The token in the app differs from `API_TOKEN`. The app stops syncing after a 401; re-save the token. |
| Commands stay `pending` | The app is closed, sync is disabled, or (iOS) the app is in the background. Open the app and tap Sync now. |
| Command ends in `conflict` | The Memory changed in the app after the AI read it. Ask the client to re-read and retry. |
| Reads look old (`stale: true`) | The app has not pushed a mirror in 24 hours. Open the app. |
| Claude/ChatGPT cannot connect | Funnel is off, `PUBLIC_URL` does not match the Funnel address, or the machine is asleep. |
| Claude Code does not show the tools | Register with `--scope user` and restart the session. |

## Security

- Anyone with `API_TOKEN` can read and change your Minds and Memories. Treat it like a password and never commit `.env`.
- With Funnel, `/mcp` is on the public internet. Use a long random token and a strong `ADMIN_PASSWORD`; the consent page locks out for 15 minutes after 5 failed attempts.
- OAuth tokens are hashed at rest; access tokens last 1 hour and refresh tokens 90 days.
