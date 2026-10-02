import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { Database } from "bun:sqlite";
import { pairingSchema } from "../pairing-schema.js";
import { createPairingCode } from "../pairing.js";
import { settings } from "./envfile.js";
import { paths } from "./paths.js";
import { box } from "./ui.js";

export interface PairProbes {
  config: () => { exists: boolean; data: string; values: Record<string, string> };
  open: (data: string) => Database;
  now: () => number;
  random: (max: number) => number;
  sleep: (ms: number) => Promise<unknown>;
  tty: boolean;
  message: (text: string) => void;
}

export const pairProbes: PairProbes = {
  config: () => ({ exists: existsSync(paths().config), ...settings() }),
  open: (data) => {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const db = new Database(join(data, "sparky-mcp.db"));
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  },
  now: Date.now, random: randomInt, sleep: Bun.sleep,
  tty: Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb"), message: console.log,
};

export async function pair(options: { noWait?: boolean; signal?: AbortSignal } = {}, probes: PairProbes = pairProbes): Promise<boolean> {
  options.signal?.throwIfAborted();
  const config = probes.config();
  if (!config.exists) throw new Error("Run sparky-mcp init first.");
  if (!config.values.PUBLIC_URL) throw new Error("PUBLIC_URL is not configured. Run sparky-mcp init first.");
  const db = probes.open(config.data);
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  try {
    db.exec(pairingSchema);
    const { code, hash, expiresAt } = createPairingCode(db, probes.now(), probes.random);
    probes.message(box("Pair Sparky", [
      `Code: ${code}`,
      `Server URL: ${config.values.PUBLIC_URL}`,
      "Expires in 5 minutes. This code works once.",
      "Open Sparky > Settings > Advanced > Remote MCP, enter the server URL and this code, then tap Pair.",
    ]));
    if (options.noWait || !probes.tty) return false;
    process.on("SIGINT", cancel);
    while (!cancelled) {
      options.signal?.throwIfAborted();
      const row = db.prepare("SELECT used_at FROM pairing_codes WHERE code_hash = ?").get(hash) as { used_at: number | null } | null;
      if (row?.used_at !== null && row?.used_at !== undefined) {
        probes.message("Paired. The app now has access.");
        return true;
      }
      if (!row || probes.now() >= expiresAt) {
        probes.message("Code expired. Run sparky-mcp pair again.");
        if (!options.signal) process.exitCode = 1;
        return false;
      }
      await probes.sleep(1000);
    }
    return false;
  } finally {
    process.removeListener("SIGINT", cancel);
    db.close();
  }
}
