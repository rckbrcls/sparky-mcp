import { settings } from "./envfile.js";
import { serviceState } from "./service.js";
import { version } from "./version.js";
import { printFields } from "./ui.js";

export async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.status === 200 && (await response.json() as { ok?: boolean }).ok === true;
  } catch { return false; }
}

export async function getStatus() {
  const { port } = settings();
  return { Service: await serviceState(), Version: version, Port: port, Health: await health(`http://127.0.0.1:${port}/health`) ? "OK" : "Unavailable" };
}

export async function status() { printFields(await getStatus()); }
