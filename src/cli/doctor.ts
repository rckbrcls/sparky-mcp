import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import { settings, publicUrl, validPort } from "./envfile.js";
import { serviceFile, serviceState } from "./service.js";
import { databaseInfo } from "./info.js";
import { health } from "./status.js";
import { run, type RunResult } from "./process.js";
import { printChecks, type Check } from "./ui.js";

export interface DoctorProbes {
  config(): Promise<{ exists: boolean; mode: number; values: Record<string, string>; port: string; data: string }>;
  service(): Promise<{ installed: boolean; state: string }>;
  run(args: string[]): Promise<RunResult>;
  health(url: string): Promise<boolean>;
  database(file: string): Promise<{ opens: boolean; syncedAt: string | null }>;
  platform: string;
  user: string;
  now(): number;
}

export const doctorProbes: DoctorProbes = {
  async config() {
    const file = paths().config;
    const exists = existsSync(file);
    return { exists, mode: exists ? statSync(file).mode & 0o777 : 0, ...settings() };
  },
  async service() {
    let installed = false;
    try { installed = existsSync(serviceFile()); } catch {}
    return { installed, state: await serviceState() };
  },
  run, health,
  async database(file) { return databaseInfo(file); },
  platform: process.platform,
  user: process.env.USER || String(process.getuid?.() ?? ""),
  now: Date.now,
};

export async function diagnose(probes: DoctorProbes = doctorProbes): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (label: string, state: Check["state"], detail: string) => checks.push({ label, state, detail });
  let cfg: Awaited<ReturnType<DoctorProbes["config"]>>;
  try { cfg = await probes.config(); }
  catch {
    add("Config", "FAIL", "Cannot read config.env. Fix its syntax and permissions or run sparky-mcp init --force.");
    cfg = { exists: false, mode: 0, values: {}, port: "8787", data: paths().data };
  }
  add("Config file", cfg.exists ? "PASS" : "FAIL", cfg.exists ? "config.env exists." : "Run sparky-mcp init.");
  add("Config permissions", cfg.exists && cfg.mode === 0o600 ? "PASS" : "FAIL", cfg.exists && cfg.mode === 0o600 ? "Mode 0600." : `Run chmod 600 '${paths().config.replace(/'/g, "'\\''")}'.`);
  const missing = ["PUBLIC_URL", "API_TOKEN", "ADMIN_PASSWORD"].filter((key) => !cfg.values[key]?.trim());
  add("Required keys", missing.length ? "FAIL" : "PASS", missing.length ? `Set ${missing.join(", ")} in config.env or run sparky-mcp init --force.` : "All required keys are present.");
  let url = "";
  try { url = publicUrl(cfg.values.PUBLIC_URL || ""); add("Public URL", "PASS", "Valid HTTPS URL."); }
  catch { add("Public URL", "FAIL", "Set PUBLIC_URL to a valid https:// URL in config.env."); }
  let portValid = true;
  try { validPort(cfg.port); } catch { portValid = false; }
  add("Port", portValid ? "PASS" : "FAIL", portValid ? `Using port ${cfg.port}.` : "Set PORT to an integer between 1 and 65535.");
  const service = await probes.service().catch(() => ({ installed: false, state: "unavailable" }));
  add("Service installed", service.installed ? "PASS" : "FAIL", service.installed ? "Service file exists." : "Run sparky-mcp start.");
  add("Service active", service.state === "active" ? "PASS" : "FAIL", service.state === "active" ? "Service is active." : "Run sparky-mcp start; use sparky-mcp logs if it exits.");
  const command = async (args: string[]) => probes.run(args).catch(() => ({ code: 127, stdout: "", stderr: "" }));
  if (probes.platform === "linux") {
    const linger = await command(["loginctl", "show-user", probes.user, "-p", "Linger"]);
    const enabled = linger.code === 0 && /Linger=yes/.test(linger.stdout);
    add("User linger", enabled ? "PASS" : "WARN", enabled ? "Enabled." : `Run loginctl enable-linger ${probes.user}. Install loginctl if unavailable.`);
  }
  const local = portValid && await probes.health(`http://127.0.0.1:${cfg.port}/health`).catch(() => false);
  add("Local health", local ? "PASS" : "FAIL", local ? "Server is healthy." : "Run sparky-mcp start and check sparky-mcp logs.");
  const db = await probes.database(join(cfg.data, "sparky-mcp.db")).catch(() => ({ opens: false, syncedAt: null }));
  add("Database", db.opens ? "PASS" : "FAIL", db.opens ? "Database opens read-only." : "Run sparky-mcp start; check data directory permissions and logs.");
  const tailscale = await command(["tailscale", "status", "--json"]);
  let dns = "";
  let loggedIn = false;
  try {
    const status = JSON.parse(tailscale.stdout);
    dns = typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : "";
    loggedIn = tailscale.code === 0 && status.BackendState === "Running" && Boolean(dns);
  } catch {}
  add("Tailscale", loggedIn ? "PASS" : "FAIL", loggedIn ? "Installed and logged in." : "Install Tailscale and run tailscale login.");
  const funnel = await command(["tailscale", "funnel", "status"]);
  const funnelActive = funnel.code === 0 && Boolean(dns) && funnel.stdout.toLowerCase().includes(`https://${dns.toLowerCase()}`) && /funnel\s+on/i.test(funnel.stdout);
  add("Funnel", funnelActive ? "WARN" : "FAIL", funnelActive ? "Funnel exposes this server publicly." : `Run sudo tailscale funnel --bg ${portValid ? cfg.port : "8787"}. Install Tailscale if unavailable.`);
  const matches = Boolean(url && dns && new URL(url).hostname.toLowerCase() === dns.toLowerCase());
  add("Tailscale hostname", matches ? "PASS" : "WARN", matches ? "PUBLIC_URL matches this host." : "Set PUBLIC_URL to this host's Tailscale HTTPS URL if using Funnel.");
  const reachable = Boolean(url) && await probes.health(`${url}/health`).catch(() => false);
  add("Public health", reachable ? "PASS" : "WARN", reachable ? "Public URL is healthy." : "Check Funnel or your proxy; local hairpin connections may fail.");
  const fresh = db.syncedAt !== null && Number.isFinite(Date.parse(db.syncedAt)) && probes.now() - Date.parse(db.syncedAt) <= 86400000;
  add("Mirror freshness", fresh ? "PASS" : "WARN", fresh ? "Synced within 24 hours." : "Open Sparky and tap Sync now.");
  return checks;
}

export async function doctor() {
  const checks = await diagnose();
  printChecks(checks);
  if (checks.some((check) => check.state === "FAIL")) process.exitCode = 1;
}
