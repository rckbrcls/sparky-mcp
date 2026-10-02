import { existsSync } from "node:fs";
import { paths } from "./paths.js";
import { readEnv, validPort } from "./envfile.js";
import { run } from "./process.js";
import { confirm, line } from "./prompt.js";
import { box, printFields } from "./ui.js";

export interface FunnelProbes {
  config(): { exists: boolean; values: Record<string, string> };
  run: typeof run;
  confirm: typeof confirm;
  wait: typeof line;
  tty: boolean;
  message(text: string): void;
}

export const funnelProbes: FunnelProbes = {
  config: () => ({ exists: existsSync(paths().config), values: readEnv() }),
  run, confirm, wait: line, tty: Boolean(process.stdin.isTTY), message: console.log,
};

export async function tailscaleHost(probes: FunnelProbes = funnelProbes): Promise<string> {
  const result = await probes.run(["tailscale", "status", "--json"]);
  if (result.code === 127) throw new Error("Tailscale is unavailable. Install Tailscale first.");
  try {
    const status = JSON.parse(result.stdout);
    if (result.code === 0 && status.BackendState === "Running" && typeof status.Self?.DNSName === "string" && status.Self.DNSName) return status.Self.DNSName.replace(/\.$/, "");
  } catch {}
  throw new Error("Tailscale is not running or logged in. Run tailscale login.");
}

export function parseFunnel(text: string, dns: string) {
  const sections = text.split(/(?=https:\/\/)/i);
  const section = sections.find((part) => {
    const host = part.match(/^https:\/\/([^\s/:]+)/i)?.[1];
    return host?.toLowerCase() === dns.toLowerCase();
  }) || "";
  const active = /funnel\s+on/i.test(section) || (/funnel\s+on/i.test(text.split(/https:\/\//i)[0] || "") && Boolean(section));
  const port = section.match(/(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/i)?.[1] || null;
  return { active, port };
}

export async function getFunnelStatus(probes: FunnelProbes = funnelProbes) {
  const dns = await tailscaleHost(probes);
  const result = await probes.run(["tailscale", "funnel", "status"]);
  if (result.code !== 0) throw new Error("Cannot read Funnel status. Check Tailscale permissions.");
  const { active, port } = parseFunnel(result.stdout, dns);
  let matches = false;
  try { matches = new URL(probes.config().values.PUBLIC_URL || "").hostname.toLowerCase() === dns.toLowerCase(); } catch {}
  return { dns, url: `https://${dns}`, active, port, matches };
}

export function funnelFields(result: Awaited<ReturnType<typeof getFunnelStatus>>) {
  return { Funnel: result.active ? "On" : "Off", URL: result.url, Port: result.port || "Unknown", PUBLIC_URL: result.matches ? "Matches this host." : `Warning: mismatch. Run sparky-mcp init --force --public-url ${result.url}` };
}

async function execute(args: string[], probes: FunnelProbes) {
  let elevated = false;
  const invoke = () => probes.run(elevated ? ["sudo", ...args] : args, elevated ? { inherit: true } : {});
  let result = await invoke();
  for (let attempt = 0; attempt < 3; attempt++) {
    const output = `${result.stdout}\n${result.stderr}`;
    const approval = output.match(/https:\/\/login\.tailscale\.com\/[^\s<>"']+/)?.[0];
    if (approval) {
      probes.message(`Open this Tailscale approval URL: ${approval}`);
      if (!probes.tty) throw new Error("Approve the URL, then run the command again in a terminal.");
      await probes.wait("Press Enter after approving: ");
      result = await invoke();
    } else if (!elevated && result.code !== 0 && /access denied|permission denied|sudo|operator/i.test(output)) {
      probes.message("Tailscale requires operator permissions. Retrying with sudo in your terminal.");
      elevated = true;
      result = await invoke();
    } else break;
  }
  if (/https:\/\/login\.tailscale\.com\//.test(`${result.stdout}\n${result.stderr}`)) throw new Error("Tailscale approval is still pending. Approve the URL and run the command again.");
  if (result.code !== 0) throw new Error(`Funnel command failed (${result.code}). Check Tailscale and run the displayed command again.`);
}

export async function manageFunnel(action: string, options: { yes?: boolean } = {}, probes: FunnelProbes = funnelProbes) {
  if (!["on", "off", "status"].includes(action)) throw new Error("Funnel expects on, off, or status.");
  if (action === "status") return getFunnelStatus(probes);
  const cfg = probes.config();
  if (action === "on" && !cfg.exists) throw new Error("Run sparky-mcp init first.");
  const port = action === "on" ? validPort(cfg.values.PORT || "8787") : "";
  const dns = await tailscaleHost(probes);
  const args = action === "on" ? ["tailscale", "funnel", "--bg", port] : ["tailscale", "funnel", "--https=443", "off"];
  probes.message(box("Public internet access", action === "on" ? [
    `Funnel makes /mcp and /api reachable from the public internet at https://${dns}.`,
    "Anyone with the URL can reach your server's login. Keep the API token and admin password private.",
    args.join(" "),
  ] : ["This disables public Funnel access.", args.join(" ")]));
  if (!options.yes && !probes.tty) throw new Error("Pass --yes to confirm.");
  if (!await probes.confirm("Continue?", options)) throw new Error("Cancelled.");
  await execute(args, probes);
  return getFunnelStatus(probes);
}

export async function funnel(action: string, options: { yes?: boolean }) {
  printFields(funnelFields(await manageFunnel(action, options)));
}
