import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { paths, createDirectories } from "./paths.js";
import { requireRun, run } from "./process.js";

const label = "com.sparky.mcp";

function systemdQuote(value: string, command = true): string {
  if (/[\n\r\0]/.test(value)) throw new Error("Service paths cannot contain control characters.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, command ? "$$$$" : "$")}"`;
}

export function systemdUnit(executable: string, home: string): string {
  return `[Unit]\nDescription=Sparky MCP server\n\n[Service]\nExecStart=${systemdQuote(executable)} serve\nEnvironment=${systemdQuote(`SPARKY_MCP_HOME=${home}`, false)}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

export function launchAgent(executable: string, home: string): string {
  const log = xml(join(home, "logs/server.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array><string>${xml(executable)}</string><string>serve</string></array>\n  <key>EnvironmentVariables</key><dict><key>SPARKY_MCP_HOME</key><string>${xml(home)}</string></dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${log}</string>\n  <key>StandardErrorPath</key><string>${log}</string>\n</dict>\n</plist>\n`;
}

export function serviceFile(platform = process.platform): string {
  if (platform === "linux") return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user/sparky-mcp.service");
  if (platform === "darwin") return join(homedir(), "Library/LaunchAgents", `${label}.plist`);
  throw new Error("Services are supported on Linux and macOS only.");
}

function domain(): string { return `gui/${process.getuid?.()}`; }
function target(): string { return `${domain()}/${label}`; }

export async function serviceState(): Promise<string> {
  if (process.platform === "linux") {
    const result = await run(["systemctl", "--user", "is-active", "sparky-mcp.service"]);
    return result.stdout.trim() || (result.code === 127 ? "unavailable" : "inactive");
  }
  if (process.platform === "darwin") {
    const result = await run(["launchctl", "print", target()]);
    if (result.code !== 0) return result.code === 127 ? "unavailable" : "inactive";
    return /state = running/.test(result.stdout) ? "active" : "loaded";
  }
  return "unsupported";
}

export function executable(): string {
  const path = resolve(process.execPath);
  if (/^bun(?:\.exe)?$/.test(path.split("/").pop()!)) throw new Error("Service installation requires the compiled sparky-mcp binary. Run bun run build first.");
  return path;
}

export async function manageService(action: "start" | "stop" | "restart") {
  const file = serviceFile();
  if (action === "start") {
    if (!existsSync(paths().config)) throw new Error("Run `sparky-mcp init` first.");
    const p = createDirectories();
    const text = process.platform === "linux" ? systemdUnit(executable(), p.home) : launchAgent(executable(), p.home);
    const changed = !existsSync(file) || readFileSync(file, "utf8") !== text;
    if (changed) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { mode: 0o600 });
    }
    if (process.platform === "linux") {
      await requireRun(["systemctl", "--user", "daemon-reload"]);
      await requireRun(["systemctl", "--user", "enable", "--now", "sparky-mcp.service"]);
      if (changed) await requireRun(["systemctl", "--user", "restart", "sparky-mcp.service"]);
    } else {
      const loaded = await run(["launchctl", "print", target()]);
      if (changed && loaded.code === 0) await requireRun(["launchctl", "bootout", target()]);
      if (changed || loaded.code !== 0) await requireRun(["launchctl", "bootstrap", domain(), file]);
      else await requireRun(["launchctl", "kickstart", "-k", target()]);
    }
  } else if (process.platform === "linux") {
    await requireRun(["systemctl", "--user", action, "sparky-mcp.service"]);
  } else if (action === "stop") {
    await requireRun(["launchctl", "bootout", target()]);
  } else {
    await requireRun(["launchctl", "kickstart", "-k", target()]);
  }
  return { action, state: await serviceState() };
}
