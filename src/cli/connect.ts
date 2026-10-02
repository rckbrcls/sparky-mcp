import { existsSync } from "node:fs";
import { paths } from "./paths.js";
import { publicUrl, readEnv } from "./envfile.js";
import { run } from "./process.js";
import { copy } from "./clipboard.js";
import { confirm, secret, line } from "./prompt.js";
import { getFunnelStatus } from "./funnel.js";

export interface ConnectOptions { url?: string; tokenStdin?: boolean }
export interface ConnectProbes {
  config(): { exists: boolean; values: Record<string, string> };
  installed(binary: string): boolean;
  run: typeof run;
  secret: typeof secret;
  stdin(): Promise<string>;
  copy: typeof copy;
  confirm: typeof confirm;
  wait: typeof line;
  funnel(): Promise<{ active: boolean }>;
  tty: boolean;
  message(text: string): void;
}

export const connectProbes: ConnectProbes = {
  config: () => ({ exists: existsSync(paths().config), values: readEnv() }),
  installed: (binary) => Boolean(Bun.which(binary)),
  run, secret, stdin: () => Bun.stdin.text(), copy, confirm, wait: line,
  funnel: getFunnelStatus, tty: Boolean(process.stdin.isTTY), message: console.log,
};

export function connectorUrl(value: string): string {
  const normalized = publicUrl(value);
  return new URL(normalized).pathname === "/" ? `${normalized}/mcp` : normalized;
}

export async function connectTarget(target: string, options: ConnectOptions = {}, probes: ConnectProbes = connectProbes) {
  const targets = ["claude-code", "codex", "claude-web", "chatgpt"];
  if (!targets.includes(target)) throw new Error(`Unknown target: ${target}. Valid targets: ${targets.join(", ")}.`);
  const cfg = probes.config();
  const guided = target === "claude-web" || target === "chatgpt";
  if (guided && (!probes.tty || !cfg.exists)) throw new Error("Run this command on the server in a terminal with a local config.env.");
  const url = options.url ? connectorUrl(options.url) : connectorUrl(`${publicUrl(cfg.values.PUBLIC_URL || "")}/mcp`);
  if (guided) {
    if (!cfg.values.ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is missing. Run sparky-mcp init.");
    const active = await probes.funnel().then((result) => result.active).catch(() => false);
    if (!active) probes.message("Warning: Funnel must be on for public access. Run sparky-mcp funnel on.");
    probes.message(target === "claude-web" ? "1. Open Settings > Connectors > Add custom connector." : "1. Open Settings > Connectors (developer mode) > create connector.");
    try {
      await probes.copy(url);
      probes.message("2. Connector URL copied. Paste it in the connector URL field. UI labels may vary.");
      await probes.wait("Press Enter to continue: ");
      await probes.copy(cfg.values.ADMIN_PASSWORD);
      probes.message("3. Admin password copied. Paste it on the consent page.");
      await probes.wait("Press Enter after pasting: ");
    } finally { await probes.copy(""); }
    return { target, url, message: "Clipboard cleared. Complete the connector setup in the product." };
  }
  const binary = target === "claude-code" ? "claude" : "codex";
  if (!probes.installed(binary)) throw new Error(`${binary} is unavailable. Install ${target === "claude-code" ? "Claude Code" : "Codex"} first.`);
  const token = (options.tokenStdin ? await probes.stdin() : !options.url && cfg.exists ? cfg.values.API_TOKEN || "" : await probes.secret("API token: ")).trim();
  if (!token || /[\r\n\0]/.test(token)) throw new Error("Provide a single non-empty API token.");
  const remove = binary === "claude" ? ["claude", "mcp", "remove", "sparky", "--scope", "user"] : ["codex", "mcp", "remove", "sparky"];
  await probes.run(remove).catch(() => {});
  const args = binary === "claude" ? ["claude", "mcp", "add", "--scope", "user", "--transport", "http", "sparky", url, "--header", `Authorization: Bearer ${token}`] : ["codex", "mcp", "add", "sparky", "--url", url, "--bearer-token-env-var", "SPARKY_MCP_TOKEN"];
  const result = await probes.run(args).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (result.code !== 0) throw new Error(`${binary} mcp add failed (${result.code}). Check the client configuration.`);
  if (binary === "codex") {
    probes.message("Export SPARKY_MCP_TOKEN in your shell profile; Codex reads it at runtime.");
    if (probes.tty && await probes.confirm("Copy the export line to the clipboard?", { defaultYes: true })) {
      await probes.copy(`export SPARKY_MCP_TOKEN='${token.replace(/'/g, "'\\''")}'`);
      probes.message("Export line copied. Paste it in your shell profile.");
    }
  }
  return { target, url, message: binary === "claude" ? "Connected. Restart your Claude Code session. The token was passed as a process argument to claude mcp add." : "Connected. Restart Codex after setting SPARKY_MCP_TOKEN." };
}

export async function connect(target: string, options: ConnectOptions) {
  console.log((await connectTarget(target, options)).message);
}
