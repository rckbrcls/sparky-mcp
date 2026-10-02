import { createHash, randomUUID } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { executable, manageService, serviceState } from "./service.js";
import { version } from "./version.js";

const repository = "rckbrcls/sparky-mcp";

export function assetName(os: string = process.platform, arch: string = process.arch): string {
  if (!["linux", "darwin"].includes(os) || !["x64", "arm64"].includes(arch)) throw new Error("Updates support Linux and macOS on x64 or arm64 only.");
  return `sparky-mcp-${os}-${arch}`;
}

export function verifyChecksum(data: Uint8Array, sums: string, name: string): void {
  const matches = sums.split(/\r?\n/).map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).filter((match) => match?.[2] === name);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous checksum for ${name}.`);
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== matches[0]![1]!.toLowerCase()) throw new Error(`Checksum mismatch for ${name}. Update aborted.`);
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) throw new Error("Cannot compare release versions. Install a tagged release with install.sh.");
  for (let i = 1; i <= 3; i++) {
    const delta = Number(left[i]) - Number(right[i]);
    if (delta) return Math.sign(delta);
  }
  if (!left[4] && !right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  const l = left[4].split(".");
  const r = right[4].split(".");
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === r[i]) continue;
    if (l[i] === undefined) return -1;
    if (r[i] === undefined) return 1;
    const ln = /^\d+$/.test(l[i]!);
    const rn = /^\d+$/.test(r[i]!);
    if (ln && rn) return Math.sign(Number(l[i]) - Number(r[i]));
    if (ln !== rn) return ln ? -1 : 1;
    return l[i]! < r[i]! ? -1 : 1;
  }
  return 0;
}

async function download(url: string): Promise<Response> {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "sparky-mcp", Accept: "application/octet-stream" }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(response.status === 404 ? "No release or asset found." : `GitHub returned HTTP ${response.status}.`);
    return response;
  } catch (error) { throw new Error(`Download failed: ${error instanceof Error ? error.message : "network error"}`); }
}

export async function checkUpdate() {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "sparky-mcp" }, signal: AbortSignal.timeout(15000) });
  } catch { throw new Error("Cannot reach GitHub. Check your network and try again."); }
  if (response.status === 404) throw new Error("No release is available yet.");
  if (!response.ok) throw new Error(`Cannot check releases: GitHub returned HTTP ${response.status}.`);
  const release = await response.json() as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
  if (!release.tag_name || !Array.isArray(release.assets)) throw new Error("Invalid GitHub release response.");
  const latest = release.tag_name.replace(/^v/, "");
  return { current: version, latest, available: compareVersions(latest, version) > 0, assets: release.assets };
}

export async function performUpdate(release: Awaited<ReturnType<typeof checkUpdate>>) {
  const file = executable();
  const name = assetName();
  const asset = release.assets.find((asset) => asset.name === name);
  const sums = release.assets.find((asset) => asset.name === "SHA256SUMS");
  if (!asset || !sums) throw new Error(`Release is missing ${name} or SHA256SUMS.`);
  const bytes = new Uint8Array(await (await download(asset.browser_download_url)).arrayBuffer());
  verifyChecksum(bytes, await (await download(sums.browser_download_url)).text(), name);
  const active = await serviceState() === "active";
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { mode: 0o700, flag: "wx" });
    chmodSync(temp, 0o755);
    renameSync(temp, file);
  } catch { throw new Error("Cannot replace the executable. Check write permissions in its directory."); }
  finally { rmSync(temp, { force: true }); }
  if (active) {
    try { await manageService("restart"); }
    catch { throw new Error(`Updated to ${release.latest}, but service restart failed. Run sparky-mcp restart.`); }
  }
  return { version: release.latest, restarted: active };
}

export async function update(checkOnly = false) {
  const release = await checkUpdate();
  if (!release.available) { console.log(`Up to date (${release.current}).`); return; }
  if (checkOnly) { console.log(`Update available: ${release.current} → ${release.latest}. Run sparky-mcp update.`); return; }
  const result = await performUpdate(release);
  console.log(`Updated to ${result.version}.${result.restarted ? " Service restarted." : ""}`);
}
