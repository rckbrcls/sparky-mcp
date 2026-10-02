import { loadEnv } from "./cli/envfile.js";
import { paths } from "./cli/paths.js";

const homePaths = paths();
const hasConfig = loadEnv(homePaths.config);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable: ${name}${hasConfig ? "" : ". Run `sparky-mcp init` first"}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dataDir: process.env.DATA_DIR ?? homePaths.data,
  publicUrl: required("PUBLIC_URL").replace(/\/+$/, ""),
  apiToken: required("API_TOKEN"),
  adminPassword: required("ADMIN_PASSWORD"),
  timeZone: process.env.USER_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
};
