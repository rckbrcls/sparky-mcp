import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { settings } from "./envfile.js";
import { serviceState } from "./service.js";
import { copy } from "./clipboard.js";
import { printFields, hint } from "./ui.js";

export function mask(value: string, reveal = false): string { return reveal ? value : value ? `••••${value.slice(-4)}` : "Not configured"; }

export function databaseInfo(file: string): { opens: boolean; syncedAt: string | null } {
  if (!existsSync(file)) return { opens: false, syncedAt: null };
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.query("PRAGMA schema_version").get();
    const row = db.query("SELECT value FROM mirror WHERE key = 'main'").get() as { value: string } | null;
    const syncedAt = row ? JSON.parse(row.value).syncedAt : null;
    return { opens: true, syncedAt: typeof syncedAt === "string" ? syncedAt : null };
  } catch { return { opens: false, syncedAt: null }; }
  finally { db?.close(); }
}

export function infoFields(values: Record<string, string>, state: string, syncedAt: string | null, reveal = false) {
  const url = values.PUBLIC_URL?.replace(/\/+$/, "") || "";
  return {
    Connector: url ? `${url}/mcp` : "Not configured",
    PUBLIC_URL: url || "Not configured",
    Local: `http://127.0.0.1:${values.PORT || "8787"}`,
    Service: state,
    "Last app sync": syncedAt || "Never",
    API_TOKEN: mask(values.API_TOKEN || "", reveal),
    ADMIN_PASSWORD: mask(values.ADMIN_PASSWORD || "", reveal),
  };
}

export async function getInfo(reveal = false) {
  const { values, data } = settings();
  return infoFields(values, await serviceState(), databaseInfo(join(data, "sparky-mcp.db")).syncedAt, reveal);
}

export async function copySecret(kind: "token" | "password") {
  const value = settings().values[kind === "token" ? "API_TOKEN" : "ADMIN_PASSWORD"];
  if (!value) throw new Error("Secret is not configured. Run `sparky-mcp init` first.");
  await copy(value);
}

export async function info(options: { reveal?: boolean; copy?: "token" | "password" }) {
  if (options.copy) { await copySecret(options.copy); console.log("Copied"); return; }
  const fields = await getInfo(options.reveal);
  printFields(fields);
  hint("Pair the app: sparky-mcp pair");
  if (fields.Connector !== "Not configured") {
    const url = `'${fields.Connector.replace(/'/g, "'\\''")}'`;
    console.log(`\nclaude mcp add --scope user --transport http sparky ${url} --header "Authorization: Bearer $API_TOKEN"\ncodex mcp add sparky --url ${url} --bearer-token-env-var SPARKY_MCP_TOKEN`);
  }
}
