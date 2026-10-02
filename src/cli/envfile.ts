import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { paths } from "./paths.js";

export type EnvValues = Record<string, string>;

export function parseEnv(text: string): EnvValues {
  const values: EnvValues = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2]!;
    if (value.startsWith('"')) {
      const quoted = value.match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/);
      if (!quoted) throw new Error("Invalid quoted config value.");
      try { value = JSON.parse(`"${quoted[1]}"`); }
      catch { value = quoted[1]!.replace(/\\(n|r|t|"|\\)/g, (_, ch: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[ch]!); }
    } else if (value.startsWith("'")) {
      const quoted = value.match(/^'([^']*)'\s*(?:#.*)?$/);
      if (!quoted) throw new Error("Invalid quoted config value.");
      value = quoted[1]!;
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]!] = value;
  }
  return values;
}

export function readEnv(file = paths().config): EnvValues {
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

export function loadEnv(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!existsSync(file)) return false;
  for (const [key, value] of Object.entries(readEnv(file))) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

export function writeEnv(file: string, values: EnvValues, overwrite = true): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const text = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid config key.");
    return `${key}=${JSON.stringify(value)}`;
  }).join("\n") + "\n";
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    if (!overwrite) {
      // Linking publishes the completed file without replacing another initializer's config.
      linkSync(temp, file);
    } else renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

export function settings(env: NodeJS.ProcessEnv = process.env) {
  const p = paths(env);
  const values = { ...readEnv(p.config), ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) } as EnvValues;
  return { values, port: values.PORT || "8787", data: values.DATA_DIR || p.data };
}

export function publicUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(normalized); } catch { throw new Error("PUBLIC_URL must be a valid HTTPS URL."); }
  if (/\s|[\u0000-\u001f\u007f]/.test(normalized) || url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_URL must be a valid HTTPS URL without credentials, query, or fragment.");
  }
  return normalized;
}

export function validPort(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("Port must be between 1 and 65535.");
  return String(Number(value));
}
