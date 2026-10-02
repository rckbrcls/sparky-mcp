# Self-hosting guide

This guide takes you from a clean machine to Claude, ChatGPT, Claude Code, or Codex creating reminders in your Sparky app. Everything runs on hardware you own or rent; nothing is hosted for you.

Pick where the server runs:

- **A. Local machine**: a computer you sit at (your Mac, a home server, a homelab box).
- **B. VPS / cloud VM**: a remote Linux machine (EC2, DigitalOcean, Hetzner, ...) that you reach over SSH.

Both paths expose the server through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), which gives you a public HTTPS address without opening any inbound port, buying a domain, or managing certificates.

You need:

- Docker and Docker Compose on the machine that runs the server.
- A free [Tailscale](https://tailscale.com) account. In the admin console, enable MagicDNS and HTTPS certificates (DNS page) and allow Funnel for your tailnet.
- The Sparky app (iOS 26 / macOS 26) with Settings > Advanced > Remote MCP.

## 1. Prepare the machine

**A. Local machine.** Install Docker and [Tailscale](https://tailscale.com/download), sign in to Tailscale, and open a terminal.

**B. VPS / cloud VM.** SSH in, then install Docker and Tailscale:

```bash
curl -fsSL https://get.docker.com | sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the login link that `tailscale up` prints. You do **not** need to open ports 80, 443, or 8787 in the firewall or security group; Funnel connects outward. Keep only SSH (22) open, restricted to your IP if you can.

Find your Tailscale address; you need it in the next step:

```bash
tailscale status --json | grep -m1 '"DNSName"'
```

It looks like `my-host.tail1234.ts.net.` (drop the trailing dot).

## 2. Download and configure

```bash
git clone https://github.com/rckbrcls/sparky-mcp.git
cd sparky-mcp
```

Create `.env` with generated secrets, so you never type or paste them. Replace the `PUBLIC_URL` value with your address:

```bash
umask 077
cat > .env <<EOF
PUBLIC_URL=https://my-host.tail1234.ts.net
API_TOKEN=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '=+/')
USER_TIMEZONE=America/Sao_Paulo
EOF
```

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Your Funnel address, no trailing slash. Must match exactly or OAuth fails. |
| `API_TOKEN` | Secret used by the Sparky app, Claude Code, and Codex. |
| `ADMIN_PASSWORD` | Asked on the consent page when you add the Claude/ChatGPT connector. |
| `USER_TIMEZONE` | Your IANA zone. Used to resolve "tomorrow at 9". |

The file is gitignored and readable only by you. Read a value back whenever you need it:

```bash
grep ^API_TOKEN= ~/sparky-mcp/.env
grep ^ADMIN_PASSWORD= ~/sparky-mcp/.env
```

On a VPS, run these from your own computer as `ssh my-vps 'grep ^API_TOKEN= ~/sparky-mcp/.env'`. Do not paste these values into chats, tickets, or screenshots.

## 3. Run it and expose it

```bash
docker compose up -d --build
docker compose logs --tail 5
```

You should see `sparky-mcp listening on :8787`. The container publishes only on `127.0.0.1:8787`; nothing is reachable from outside yet. Check it locally:

```bash
curl -i http://127.0.0.1:8787/api/commands    # 401 without a token
```

Now turn on Funnel:

```bash
sudo tailscale funnel --bg 8787
```

Without `sudo` this fails on Linux unless you set an operator once with `sudo tailscale set --operator=$USER`. If Funnel is not yet enabled for your tailnet, Tailscale prints a link to approve it; open it and run the command again.

> **Funnel puts `/mcp` and `/api` on the public internet.** Anyone who finds the URL can reach the login of your server. Make sure `API_TOKEN` is long and random and `ADMIN_PASSWORD` is strong and unique, which the `.env` above gives you. Turn Funnel off when you do not need it.

Verify from outside your network (for example your phone on mobile data): `https://my-host.tail1234.ts.net/api/commands` should answer `401`.

The address is permanent for the machine. Use the HTTPS address everywhere, including the Sparky app; iOS blocks plain `http://`.

To stop sharing publicly:

```bash
sudo tailscale funnel --https=443 off
```

If you only need the app, Claude Code, and Codex on your own devices (no Claude/ChatGPT connectors), `sudo tailscale serve --bg 8787` keeps the server private to your tailnet.

## 4. Connect the Sparky app

1. Open Sparky > Settings > Advanced > Remote MCP.
2. Enter the Server URL (your `PUBLIC_URL`) and the API token. The token lives in the server's `.env`; read it with the `grep` command from step 2 and paste it straight into the app (on a VPS, run that command over SSH from the computer you are using).
3. Turn the toggle on and tap Test connection, then Sync now.

Sync behavior: macOS keeps syncing in the background; iOS syncs only while the app is active. Commands queued while the app is closed are applied the next time it syncs.

## 5. Connect an AI client

Replace `PUBLIC_URL` with your address.

**Claude Code and Codex** run on your own computer, so they need the token from the server. Read it into a shell variable without printing it (for a VPS, wrap the `grep` in `ssh my-vps '...'`):

```bash
API_TOKEN=$(grep ^API_TOKEN= ~/sparky-mcp/.env | cut -d= -f2)        # server is this machine
API_TOKEN=$(ssh my-vps 'grep ^API_TOKEN= ~/sparky-mcp/.env' | cut -d= -f2)   # server is a VPS
```

Claude Code (remove an older `sparky` entry first, if any, then restart the session so the tools load):

```bash
claude mcp remove sparky --scope user 2>/dev/null
claude mcp add --scope user --transport http sparky PUBLIC_URL/mcp \
  --header "Authorization: Bearer $API_TOKEN"
```

Codex (add the export to your shell profile so it persists):

```bash
export SPARKY_MCP_TOKEN=$API_TOKEN
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
docker run --rm -v sparky-mcp_sparky-mcp-data:/data -v "$PWD":/backup node:24-slim \
  tar czf /backup/sparky-mcp-data.tgz -C /data .
```

The volume name is the folder name plus `_sparky-mcp-data` (`docker volume ls` shows it). The notes and reminders themselves live in the app; the server only holds a mirror and a queue.

**Rotate secrets**: edit `API_TOKEN` or `ADMIN_PASSWORD` in `.env` (new value from `openssl rand -hex 32`), run `docker compose up -d`, then update the token in the Sparky app and re-register your clients (step 5).

**Stop sharing publicly**: `sudo tailscale funnel --https=443 off`.

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
