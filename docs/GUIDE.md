# Guide

The [Quick start](../README.md#quick-start) is two commands: install the binary and run `sparky-mcp setup`. This guide explains what `setup` does, how to connect the Sparky app and your AI clients, how to operate the server, and what to do when something goes wrong.

Nothing here is hosted for you. The server runs on a machine you own or rent, and Sparky works unchanged without it.

## Requirements

- **A machine that stays on:** your Mac, a home server or homelab box, or a VPS / cloud VM (EC2, DigitalOcean, Hetzner, ...). Linux x64/arm64 (glibc: Ubuntu, Debian, Fedora, ...) or macOS. Alpine (musl) is not supported by the release binaries.
- **Tailscale:** a free [Tailscale](https://tailscale.com) account, signed in on that machine. In the admin console, enable MagicDNS and HTTPS certificates (DNS page) and allow Funnel for your tailnet. Funnel gives you a public HTTPS address without opening any inbound port, buying a domain, or managing certificates.
- **A VPS:** SSH in first and install Tailscale (`curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`). You do not need to open ports 80, 443, or 8787 in the firewall or security group; Funnel connects outward. Keep only SSH (22) open, restricted to your IP if you can.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/rckbrcls/sparky-mcp/main/install.sh | sh
```

The script downloads the binary for your system from the latest GitHub release, verifies its SHA-256 checksum, and installs it to `~/.local/bin/sparky-mcp`. It never uses `sudo`. If `~/.local/bin` is not on your `PATH`, it tells you. Read the script first if you like.

## Guided setup

```bash
sparky-mcp setup
```

Five steps, safe to run again: each one notices what is already done and keeps it (an existing configuration is never overwritten).

| Step | What happens |
| --- | --- |
| 1. Prerequisites | Checks the OS and your Tailscale login, and reads your `https://<host>.<tailnet>.ts.net` address. |
| 2. Configuration | Creates `~/.sparky-mcp/` with a random API token and admin password. They are never printed. |
| 3. Service | Starts a user service (systemd on Linux, a LaunchAgent on macOS) and waits for it to be healthy. |
| 4. Public access | Explains Funnel and asks before turning it on. Skip it if you only use the Sparky app, Claude Code, and Codex over your tailnet. Claude and ChatGPT connectors need it. |
| 5. Verify and connect | Runs `doctor`, then lets you pair the Sparky app and connect Claude Code, Codex, Claude, and ChatGPT. |

Flags: `--public-url URL`, `--funnel` / `--no-funnel`, `--no-pair`, `--yes` (non-interactive defaults). `--yes` alone never turns Funnel on; only an explicit `--funnel` does.

On Linux, run `loginctl enable-linger $USER` once so the service keeps running when you are logged out (`doctor` tells you if it is needed).

> **Funnel puts `/mcp` and `/api` on the public internet.** Anyone who finds the URL can reach the login of your server. The generated secrets are long and random: keep them private, and turn Funnel off when you do not need it (`sparky-mcp funnel off`).

## Connect the Sparky app

On the server run `sparky-mcp pair`. It prints a code that works once and expires in 5 minutes. In Sparky open Settings > Advanced > Remote MCP, enter the server URL and the code, and tap **Pair**. The app receives the API token itself; you never copy it. After five wrong codes pairing locks for 15 minutes (running `pair` again resets it).

On a VPS, run it over SSH with a terminal so it can wait for the app: `ssh -t my-vps sparky-mcp pair`.

Sync behavior: macOS keeps syncing in the background; commands queued while the app is closed are applied the next time it syncs. The iPhone app is unreleased.

## Connect an AI client

`setup` offers this, or run it later.

**Claude Code and Codex** on the same machine as the server: `sparky-mcp connect claude-code` and `sparky-mcp connect codex`. For Codex, export the token in your shell profile; the command offers to copy the export line.

**Claude Code or Codex on another computer** (for example your Mac, with the server on a VPS): install `sparky-mcp` there too, then:

```bash
sparky-mcp connect claude-code --url https://my-host.tail1234.ts.net
```

It asks for the API token with hidden input (or reads it from stdin with `--token-stdin`). Get the token from the server with `ssh my-vps 'sparky-mcp info --reveal'` and paste it; do not share it in chats or tickets.

**Claude (web, desktop, mobile)** and **ChatGPT**: run `sparky-mcp connect claude-web` or `sparky-mcp connect chatgpt` on the server. It copies the connector URL, then the admin password, to your clipboard at the right moments and clears the clipboard afterwards. On a machine with no clipboard (a headless server or a VPS over SSH) it prints the URL instead and asks before showing the password on screen; you can also read it any time with `sparky-mcp info --reveal`. These connectors need Funnel. Vendor UIs and plan requirements change; check their current remote MCP documentation.

Try it: ask "list my minds", then "remind me to call the dentist tomorrow at 9". The reply contains a `commandId`; the app applies it within about 10 seconds, and `get_command_status` shows `done`, `failed`, or `conflict`.

## Operate it

| Task | Command |
| --- | --- |
| Summary and next step | `sparky-mcp` |
| Service state and health | `sparky-mcp status` |
| Read logs | `sparky-mcp logs` (add `-f` to follow) |
| Restart or stop | `sparky-mcp restart`, `sparky-mcp stop` |
| Check for / install a new version | `sparky-mcp update --check`, `sparky-mcp update` |
| Diagnose problems | `sparky-mcp doctor` |
| Show or copy secrets | `sparky-mcp info --reveal`, `sparky-mcp info --copy token` |

**Back up** the data. Stop the service first so the SQLite files are consistent:

```bash
sparky-mcp stop
tar czf sparky-mcp-backup.tgz -C ~ .sparky-mcp
sparky-mcp start
```

The notes and reminders themselves live in the app; the server only holds a mirror and a queue.

**Rotate secrets:** re-run `sparky-mcp init --force --public-url <your URL>`, restart, then pair the app again and re-run `connect` for your clients. Existing connector sessions in Claude/ChatGPT must be re-authorized.

**Move to another machine:** stop the service, copy `~/.sparky-mcp/` to the new machine (it keeps your secrets and database), install the binary there, and run `sparky-mcp start` and `sparky-mcp funnel on`.

## Migrating from a Docker install

Older versions of this project ran in Docker. To switch without changing your token, password, or connector:

```bash
sparky-mcp init --import-env ~/sparky-mcp/.env     # keeps the same secrets
docker compose -f ~/sparky-mcp/docker-compose.yml down
sparky-mcp start
```

The new server starts with an empty database; open Sparky and tap Sync now to refill the mirror. Queued commands from the old container are not carried over.

## Troubleshooting

Start with `sparky-mcp doctor`; it names the problem and the fix.

| Symptom | Check |
| --- | --- |
| `sparky-mcp: command not found` | Add `~/.local/bin` to your `PATH`. |
| Service will not start | `sparky-mcp logs`; a required setting is missing or the port is taken. |
| App says unauthorized | The token in the app differs from the server's. Pair again with `sparky-mcp pair`. |
| Commands stay `pending` | The app is closed or sync is disabled. Open the app and tap Sync now. |
| Command ends in `conflict` | The Memory changed in the app after the AI read it. Ask the client to re-read and retry. |
| Reads look old (`stale: true`) | The app has not pushed a mirror in 24 hours. Open the app. |
| Claude/ChatGPT cannot connect | Funnel is off, `PUBLIC_URL` does not match the Funnel address, or the machine is asleep. |
| Claude Code does not show the tools | Restart the Claude Code session after `connect`. |
| Linux service stops when you log out | Run `loginctl enable-linger $USER`. |
| `funnel on` says access denied | Tailscale needs root; the command retries with `sudo` in your terminal, or run `sudo tailscale set --operator=$USER` once. |
