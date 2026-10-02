import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export function paths(env: NodeJS.ProcessEnv = process.env) {
  const home = resolve(env.SPARKY_MCP_HOME || join(homedir(), ".sparky-mcp"));
  return { home, config: join(home, "config.env"), data: join(home, "data"), logs: join(home, "logs"), log: join(home, "logs/server.log") };
}

export function createDirectories() {
  const p = paths();
  for (const dir of [p.home, p.data, p.logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return p;
}
