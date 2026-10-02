import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import { settings, publicUrl } from "./envfile.js";
import { serviceState } from "./service.js";
import { databaseInfo } from "./info.js";
import { health } from "./status.js";
import { run } from "./process.js";
import { parseFunnel } from "./funnel.js";
import { version } from "./version.js";
import { color, fieldsText, header, highlight, type UIOptions } from "./ui.js";

export interface SummaryState { initialized: boolean; service: string; healthy: boolean; url: string; funnel: boolean | null; syncedAt: string | null; now: number }
export interface SummaryProbes {
  config(): { exists: boolean; values: Record<string, string>; port: string; data: string };
  service(): Promise<string>;
  health(url: string): Promise<boolean>;
  funnel(url: string): Promise<boolean | null>;
  database(file: string): { syncedAt: string | null };
  now(): number;
}

export const summaryProbes: SummaryProbes = {
  config: () => ({ exists: existsSync(paths().config), ...settings() }),
  service: () => serviceState(700),
  health: (url) => health(url, 700),
  async funnel(url) {
    const result = await run(["tailscale", "funnel", "status"], { timeout: 700 });
    if (result.code !== 0) return null;
    return parseFunnel(result.stdout, new URL(url).hostname).active;
  },
  database: databaseInfo, now: Date.now,
};

export function nextStep(state: Pick<SummaryState, "initialized" | "service" | "funnel" | "syncedAt" | "now">): string {
  if (!state.initialized) return "sparky-mcp setup";
  if (state.service !== "active") return "sparky-mcp start";
  if (state.funnel === false) return "sparky-mcp funnel on";
  if (!state.syncedAt || !Number.isFinite(Date.parse(state.syncedAt))) return "sparky-mcp pair";
  if (state.now - Date.parse(state.syncedAt) > 86400000) return "Open Sparky and tap Sync now";
  return "All good. Run sparky-mcp help for commands.";
}

export function relativeTime(value: string | null, now: number): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Never";
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 60) return "Just now";
  const [count, unit] = seconds < 3600 ? [Math.floor(seconds / 60), "minute"] : seconds < 86400 ? [Math.floor(seconds / 3600), "hour"] : [Math.floor(seconds / 86400), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

async function bounded<T>(probe: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(probe).catch(() => fallback), new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), 900); })]);
  } finally { clearTimeout(timer); }
}

export async function getSummary(probes: SummaryProbes = summaryProbes): Promise<SummaryState> {
  const cfg = probes.config();
  if (!cfg.exists) return { initialized: false, service: "inactive", healthy: false, url: "", funnel: null, syncedAt: null, now: probes.now() };
  let url = "";
  try { url = publicUrl(cfg.values.PUBLIC_URL || ""); } catch {}
  const [service, healthy, funnel] = await Promise.all([
    bounded(() => probes.service(), "unavailable"),
    bounded(() => probes.health(`http://127.0.0.1:${cfg.port}/health`), false),
    bounded(() => url ? probes.funnel(url) : Promise.resolve(null), null),
  ]);
  let syncedAt: string | null = null;
  try { syncedAt = probes.database(join(cfg.data, "sparky-mcp.db")).syncedAt; } catch {}
  return { initialized: true, service, healthy, url, funnel, syncedAt, now: probes.now() };
}

export function summaryText(state: SummaryState, options: UIOptions = {}): string {
  const lines = [header(version, options)];
  if (!state.initialized) lines.push("", "Sparky MCP isn't set up yet.");
  else lines.push("", fieldsText({
    Service: state.service, Health: state.healthy ? "OK" : "Unavailable", Version: version,
    "Connector URL": state.url ? `${state.url}/mcp` : "Not configured",
    "Public access": state.funnel === null ? "Unknown" : state.funnel ? "On" : "Off",
    "Last app sync": relativeTime(state.syncedAt, state.now),
  }, options));
  lines.push("", `${color("Next step", 2, options)}  ${highlight(nextStep(state), options)}`);
  return lines.join("\n");
}

export async function summary() { console.log(summaryText(await getSummary())); }
