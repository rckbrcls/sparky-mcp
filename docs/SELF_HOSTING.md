# Self-hosting guide

This guide takes you from a clean machine to Claude, ChatGPT, Claude Code, or Codex creating reminders in your Sparky app. Everything runs on hardware you own or rent; nothing is hosted for you.

`sparky-mcp` is a single binary. It is the server and the command line tool that sets it up, runs it as a background service, and checks that everything works.

Pick where it runs:

- **A. Local machine**: a computer you sit at (your Mac, a home server, a homelab box).
- **B. VPS / cloud VM**: a remote Linux machine (EC2, DigitalOcean, Hetzner, ...) that you reach over SSH.

Both paths expose the server through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), which gives you a public HTTPS address without opening any inbound port, buying a domain, or managing certificates.

You need:

- Linux (x64 or arm64, glibc: Ubuntu, Debian, Fedora, ...) or macOS (Apple Silicon or Intel).
- A free [Tailscale](https://tailscale.com) account. In the admin console, enable MagicDNS and HTTPS certificates (DNS page) and allow Funnel for your tailnet.
- The Sparky app (iOS 26 / macOS 26) with Settings > Advanced > Remote MCP.

## 1. Install

**B. VPS only**: SSH in first and install Tailscale:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the login link that `tailscale up` prints. You do **not** need to open ports 80, 443, or 8787 in a firewall or security group; Funnel connects outward. Keep only SSH (22) open, restricted to your IP if you can.

**A. Local machine**: install and sign in to [Tailscale](https://tailscale.com/download).

Then, on the machine that will run the server:

```bash
curl -fsSL https://raw.githubusercontent.com/rckbrcls/sparky-mcp/main/install.sh | sh
```

The script downloads the binary for your system from the latest GitHub release, verifies its SHA-256 checksum, and installs it to `~/.local/bin/sparky-mcp`. It never uses `sudo`. If `~/.local/bin` is not on your `PATH`, it tells you. You can read the script before running it.

## 2. Set up

```bash
sparky-mcp init
```

This creates `~/.sparky-mcp/` with:

| Path | Contents |
| --- | --- |
| `config.env` | Settings and secrets, readable only by you (mode 0600). |
| `data/` | The SQLite database (mirror, command queue, OAuth registrations). |
| `logs/` | Service log (macOS). |

`init` generates a random `API_TOKEN` (for the Sparky app, Claude Code, and Codex) and `ADMIN_PASSWORD` (asked on the consent page when you add the Claude/ChatGPT connector), and never prints them. It detects your Tailscale address for `PUBLIC_URL` automatically; if Tailscale is not signed in it asks, or you can pass `--public-url https://my-host.tail1234.ts.net`.

Useful flags: `--timezone America/Sao_Paulo`, `--port 8787`, `--force` (replace an existing config).

## 3. Run it and expose it

```bash
sparky-mcp start
sparky-mcp status
```

`start` installs a user service (systemd on Linux, a LaunchAgent on macOS), starts it, and keeps it running across crashes and reboots. On Linux, run `loginctl enable-linger $USER` once so the service keeps running when you are logged out (`sparky-mcp doctor` tells you if it is needed).

Now turn on Funnel:

```bash
sudo tailscale funnel --bg 8787
```

Without `sudo` this fails on Linux unless you set an operator once with `sudo tailscale set --operator=$USER`. If Funnel is not yet enabled for your tailnet, Tailscale prints a link to approve it; open it and run the command again.

> **Funnel puts `/mcp` and `/api` on the public internet.** Anyone who finds the URL can reach the login of your server. `init` generates a long random token and a strong password, so keep them private and turn Funnel off when you do not need it.

Check everything:

```bash
sparky-mcp doctor
```

`doctor` verifies the config, service, local and public health, database, Tailscale, Funnel, and the last time the app synced, and prints the exact fix for anything wrong. A `WARN` for "Funnel exposes this server publicly" is expected and intentional.

The address is permanent for the machine. Use the HTTPS address everywhere, including the Sparky app; iOS blocks plain `http://`.

To stop sharing publicly:

```bash
sudo tailscale funnel --https=443 off
```

If you only need the app, Claude Code, and Codex on your own devices (no Claude/ChatGPT connectors), `sudo tailscale serve --bg 8787` keeps the server private to your tailnet.

## 4. Connect the Sparky app

```bash
sparky-mcp info
```

shows your connector URL and masked secrets. Reveal or copy one when you need it:

```bash
sparky-mcp info --reveal            # print secrets in full
sparky-mcp info --copy token        # put the API token on the clipboard
```

1. Open Sparky > Settings > Advanced > Remote MCP.
2. Enter the Server URL (your `PUBLIC_URL`) and the API token.
3. Turn the toggle on and tap Test connection, then Sync now.

On a VPS, read the token over SSH from the computer you are using, and paste it straight into the app. Do not paste it into chats or tickets:

```bash
ssh my-vps 'sparky-mcp info --reveal'
```

Sync behavior: macOS keeps syncing in the background; iOS syncs only while the app is active. Commands queued while the app is closed are applied the next time it syncs.

## 5. Connect an AI client

`sparky-mcp info` prints the connector URL and the matching commands. Replace `PUBLIC_URL` with your address.

**Claude Code and Codex** run on your own computer, so they need the token from the server. Read it into a shell variable without printing it:

```bash
API_TOKEN=$(sed -n 's/^API_TOKEN="\(.*\)"$/\1/p' ~/.sparky-mcp/config.env)                              # server is this machine
API_TOKEN=$(ssh my-vps "sed -n 's/^API_TOKEN=\"\(.*\)\"\$/\1/p' ~/.sparky-mcp/config.env")              # server is a VPS
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

**Claude (web, desktop, mobile)**: Settings > Connectors > Add custom connector > URL `PUBLIC_URL/mcp`. Claude opens the consent page; enter the `ADMIN_PASSWORD` (`sparky-mcp info --copy password`). Requires Funnel (step 3).

**ChatGPT**: enable developer mode, add a connector with `PUBLIC_URL/mcp`, and complete the same consent flow. Requires Funnel.

Product UIs and plan requirements change; check each vendor's current remote MCP documentation.

Try it: ask "list my minds", then "remind me to call the dentist tomorrow at 9". The reply contains a `commandId`; the app applies it within about 10 seconds. `get_command_status` shows `done`, `failed`, or `conflict`.

## 6. Operate it

| Task | Command |
| --- | --- |
| See service state and health | `sparky-mcp status` |
| Read logs | `sparky-mcp logs` (add `-f` to follow) |
| Restart or stop | `sparky-mcp restart`, `sparky-mcp stop` |
| Check for a new version | `sparky-mcp update --check` |
| Install the latest version | `sparky-mcp update` (verifies the checksum, replaces the binary, restarts the service) |
| Diagnose problems | `sparky-mcp doctor` |

**Back up** the data. Stop the service first so the SQLite files are consistent:

```bash
sparky-mcp stop
tar czf sparky-mcp-backup.tgz -C ~ .sparky-mcp
sparky-mcp start
```

The notes and reminders themselves live in the app; the server only holds a mirror and a queue.

**Rotate secrets**: re-run `init` with `--force` and the same URL, restart, then update the token in the Sparky app and re-register your clients (step 5). Existing connector sessions in Claude/ChatGPT must be re-authorized.

```bash
sparky-mcp init --force --public-url PUBLIC_URL
sparky-mcp restart
```

**Move to another machine**: stop the service, copy `~/.sparky-mcp/` to the new machine (it keeps your secrets and database), install the binary there, run `sparky-mcp start`, and point Funnel at it.

## Migrating from a Docker install

Older versions of this project ran in Docker. To switch without changing your token, password, or connector:

```bash
sparky-mcp init --import-env ~/sparky-mcp/.env     # keeps the same secrets
docker compose -f ~/sparky-mcp/docker-compose.yml down
sparky-mcp start
```

The server then starts with an empty database; open Sparky and tap Sync now to refill the mirror. Queued commands from the old container are not carried over.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `sparky-mcp: command not found` | Add `~/.local/bin` to your `PATH`. |
| Service will not start | `sparky-mcp logs`; a required setting is missing or the port is taken. Run `sparky-mcp doctor`. |
| App says unauthorized | The token in the app differs from the server's. The app stops syncing after a 401; re-save the token. |
| Commands stay `pending` | The app is closed, sync is disabled, or (iOS) the app is in the background. Open the app and tap Sync now. |
| Command ends in `conflict` | The Memory changed in the app after the AI read it. Ask the client to re-read and retry. |
| Reads look old (`stale: true`) | The app has not pushed a mirror in 24 hours. Open the app. |
| Claude/ChatGPT cannot connect | Funnel is off, `PUBLIC_URL` does not match the Funnel address, or the machine is asleep. `sparky-mcp doctor` checks all three. |
| Claude Code does not show the tools | Register with `--scope user` and restart the session. |
| Linux service stops when you log out | Run `loginctl enable-linger $USER`. |

## Security

- Anyone with the API token can read and change your Minds and Memories. Treat it like a password.
- `config.env` is created with mode 0600; `sparky-mcp doctor` warns if that changes. The installer and `update` verify SHA-256 checksums before replacing the binary.
- With Funnel, `/mcp` is on the public internet. The consent page locks out for 15 minutes after 5 failed attempts.
- OAuth tokens are hashed at rest; access tokens last 1 hour and refresh tokens 90 days.
- Alpine Linux (musl) is not supported by the release binaries.
