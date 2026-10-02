import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import { settings, publicUrl, validPort } from "./envfile.js";
import { manageService, serviceFile, serviceState } from "./service.js";
import { databaseInfo } from "./info.js";
import { health } from "./status.js";
import { run, type RunResult } from "./process.js";
import { parseFunnel } from "./funnel.js";
import { confirm } from "./prompt.js";
import { printChecks, hint, type Check } from "./ui.js";

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
  const funnelActive = funnel.code === 0 && Boolean(dns) && parseFunnel(funnel.stdout, dns).active;
  add("Funnel", funnelActive ? "WARN" : "FAIL", funnelActive ? "Funnel exposes this server publicly." : `Run sparky-mcp funnel on (handles sudo tailscale funnel --bg ${portValid ? cfg.port : "8787"} when needed). Install Tailscale if unavailable.`);
  const matches = Boolean(url && dns && new URL(url).hostname.toLowerCase() === dns.toLowerCase());
  add("Tailscale hostname", matches ? "PASS" : "WARN", matches ? "PUBLIC_URL matches this host." : "Set PUBLIC_URL to this host's Tailscale HTTPS URL if using Funnel.");
  const reachable = Boolean(url) && await probes.health(`${url}/health`).catch(() => false);
  add("Public health", reachable ? "PASS" : "WARN", reachable ? "Public URL is healthy." : "Check Funnel or your proxy; local hairpin connections may fail.");
  const fresh = db.syncedAt !== null && Number.isFinite(Date.parse(db.syncedAt)) && probes.now() - Date.parse(db.syncedAt) <= 86400000;
  add("Mirror freshness", fresh ? "PASS" : "WARN", fresh ? "Synced within 24 hours." : "Open Sparky and tap Sync now.");
  return checks;
}

export interface FixProbes {
  paths: typeof paths;
  exists(file: string): boolean;
  chmod(file: string, mode: number): void;
  mkdir(file: string, mode: number): void;
  confirm: typeof confirm;
  start(): Promise<unknown>;
}

export const fixProbes: FixProbes = {
  paths, exists: existsSync, chmod: chmodSync,
  mkdir: (file, mode) => { mkdirSync(file, { recursive: true, mode }); },
  confirm, start: () => manageService("start"),
};

export async function fixDoctor(options: { yes?: boolean } = {}, probes: DoctorProbes = doctorProbes, fixes: FixProbes = fixProbes) {
  const checks = await diagnose(probes);
  const fixed: string[] = [];
  const hints: string[] = [];
  const failed = (label: string) => checks.some((check) => check.label === label && check.state !== "PASS");
  const p = fixes.paths();
  if (failed("Config permissions") && fixes.exists(p.config)) {
    fixes.chmod(p.config, 0o600);
    fixed.push("Config permissions (0600)");
  }
  const cfg = await probes.config().catch(() => null);
  for (const dir of [cfg?.data || p.data, p.logs]) {
    if (!fixes.exists(dir)) { fixes.mkdir(dir, 0o700); fixed.push(`Created ${dir} (0700)`); }
  }
  if (probes.platform === "linux" && failed("User linger")) {
    const args = ["loginctl", "enable-linger", probes.user];
    if (await fixes.confirm(`Run ${args.join(" ")}?`, options)) {
      const result = await probes.run(args);
      if (result.code === 0) fixed.push("User linger");
      else hints.push(`Run ${args.join(" ")} manually; elevated permissions may be required.`);
    }
  }
  if (failed("Service installed") || failed("Service active")) {
    if (await fixes.confirm("Run sparky-mcp start?", options)) {
      try { await fixes.start(); fixed.push("Service started"); }
      catch { hints.push("Run sparky-mcp start manually; check configuration and service permissions."); }
    }
  }
  if (failed("Tailscale")) hints.push("Run tailscale login. Install Tailscale if unavailable.");
  if (failed("Funnel")) hints.push("Run sparky-mcp funnel on.");
  return { checks: await diagnose(probes), fixed, hints };
}

export function doctorExitCode(checks: Check[]): number { return checks.some((check) => check.state === "FAIL") ? 1 : 0; }

export async function doctor(options: { fix?: boolean; yes?: boolean } = {}, probes: DoctorProbes = doctorProbes, fixes: FixProbes = fixProbes) {
  const result = options.fix ? await fixDoctor(options, probes, fixes) : { checks: await diagnose(probes), fixed: [], hints: [] };
  printChecks(result.checks);
  if (options.fix) console.log(`Fixed: ${result.fixed.join(", ") || "None"}`);
  for (const text of result.hints) hint(text);
  if (doctorExitCode(result.checks)) process.exitCode = 1;
}
