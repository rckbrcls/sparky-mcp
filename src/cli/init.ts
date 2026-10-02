import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { createDirectories, paths } from "./paths.js";
import { publicUrl, readEnv, validPort, writeEnv } from "./envfile.js";
import { run } from "./process.js";
import { printFields, hint } from "./ui.js";

export interface InitOptions { publicUrl?: string; timezone?: string; port?: string; importEnv?: string; force?: boolean; yes?: boolean }

async function prompt(question: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question(question)).trim(); } finally { input.close(); }
}

export async function initialize(options: InitOptions) {
  const p = paths();
  if (existsSync(p.config) && !options.force) throw new Error("Config already exists. Use --force to replace it.");
  if (options.importEnv && !existsSync(options.importEnv)) throw new Error("Import file does not exist.");
  const imported = options.importEnv ? readEnv(options.importEnv) : {};
  let url = options.publicUrl || imported.PUBLIC_URL;
  if (!url) {
    const result = await run(["tailscale", "status", "--json"]);
    try {
      const status = JSON.parse(result.stdout);
      if (result.code === 0 && status.Self?.DNSName) url = `https://${status.Self.DNSName.replace(/\.$/, "")}`;
    } catch {}
  }
  if (!url && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb" && !options.yes) url = await prompt("Public HTTPS URL: ");
  if (!url) throw new Error("Provide --public-url https://your-host. Run tailscale login to enable auto-detection.");
  url = publicUrl(url);
  let timezone = options.timezone || imported.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb" && !options.yes) timezone = await prompt("Time zone [UTC]: ") || "UTC";
  timezone ||= "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new Error("Invalid time zone."); }
  const values = {
    PUBLIC_URL: url,
    API_TOKEN: imported.API_TOKEN?.trim() || randomBytes(32).toString("hex"),
    ADMIN_PASSWORD: imported.ADMIN_PASSWORD?.trim() || randomBytes(18).toString("base64url"),
    USER_TIMEZONE: timezone,
    PORT: validPort(options.port || imported.PORT || "8787"),
  };
  createDirectories();
  writeEnv(p.config, values, Boolean(options.force));
  return { config: p.config, data: p.data, logs: p.logs };
}

export async function init(options: InitOptions) {
  const result = await initialize(options);
  console.log("Configuration created.");
  printFields({ Config: result.config, Data: result.data, Logs: result.logs });
  hint("Next steps: sparky-mcp start, sparky-mcp info, sparky-mcp doctor");
}
