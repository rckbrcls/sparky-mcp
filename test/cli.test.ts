import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, readEnv, loadEnv, writeEnv, publicUrl } from "../src/cli/envfile.js";
import { initialize, init } from "../src/cli/init.js";
import { paths } from "../src/cli/paths.js";
import { systemdUnit, launchAgent } from "../src/cli/service.js";
import { mask, infoFields, databaseInfo } from "../src/cli/info.js";
import { diagnose, type DoctorProbes } from "../src/cli/doctor.js";
import { assetName, verifyChecksum, compareVersions } from "../src/cli/update.js";

const directories: string[] = [];
const originalHome = process.env.SPARKY_MCP_HOME;

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "sparky-mcp-test-"));
  directories.push(home);
  return home;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.SPARKY_MCP_HOME;
  else process.env.SPARKY_MCP_HOME = originalHome;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("env files", () => {
  test("parses quotes, comments, CRLF, exports, and equals signs", () => {
    expect(parseEnv('# note\r\nexport PUBLIC_URL=https://example.test # note\r\nAPI_TOKEN="a=b#c"\nADMIN_PASSWORD=\'a # b\'\nEMPTY=\nESCAPED="line\\nquote\\\"\\\\"\n')).toEqual({
      PUBLIC_URL: "https://example.test", API_TOKEN: "a=b#c", ADMIN_PASSWORD: "a # b", EMPTY: "", ESCAPED: 'line\nquote"\\',
    });
    expect(() => parseEnv('TOKEN="unfinished')).toThrow("Invalid quoted config value");
  });

  test("writes atomically with 0600 and round-trips values", () => {
    const home = tempHome();
    const file = join(home, "config.env");
    const values = { TOKEN: 'a=b # "quoted"\nnext\\line', EMPTY: "" };
    writeEnv(file, values);
    expect(readEnv(file)).toEqual(values);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    writeEnv(file, { TOKEN: "replacement" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(["config.env"]);
    expect(() => writeEnv(file, { TOKEN: "other" }, false)).toThrow();
    expect(readEnv(file).TOKEN).toBe("replacement");
    expect(readdirSync(home)).toEqual(["config.env"]);
  });

  test("real environment wins, including explicitly empty values", () => {
    const file = join(tempHome(), "config.env");
    writeEnv(file, { PUBLIC_URL: "https://file.test", API_TOKEN: "file-token", EMPTY: "file-value" });
    const env: NodeJS.ProcessEnv = { PUBLIC_URL: "https://env.test", EMPTY: "" };
    expect(loadEnv(file, env)).toBe(true);
    expect(env).toEqual({ PUBLIC_URL: "https://env.test", API_TOKEN: "file-token", EMPTY: "" });
    expect(loadEnv(`${file}.missing`, env)).toBe(false);
  });

  test("normalizes HTTPS URLs and rejects unsafe or non-HTTPS values", () => {
    expect(publicUrl(" https://example.test/// ")).toBe("https://example.test");
    for (const value of ["http://example.test", "invalid", "https://user:pass@example.test", "https://example.test?q=1", "https://example.test/#fragment"]) {
      expect(() => publicUrl(value)).toThrow();
    }
  });
});

async function configProcess(home: string, overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const key of ["PUBLIC_URL", "API_TOKEN", "ADMIN_PASSWORD", "PORT", "DATA_DIR", "USER_TIMEZONE"]) delete env[key];
  const module = new URL("../src/config.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "--eval", `const { config } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(config));`], {
    cwd: home,
    env: { ...env, SPARKY_MCP_HOME: home, ...overrides },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe("config loading", () => {
  test("loads home config with process environment precedence", async () => {
    const home = tempHome();
    writeEnv(join(home, "config.env"), {
      PUBLIC_URL: "https://file.test", API_TOKEN: "file-token", ADMIN_PASSWORD: "file-password", PORT: "9999", USER_TIMEZONE: "UTC",
    });
    const result = await configProcess(home, { PUBLIC_URL: "https://env.test/", API_TOKEN: "env-token" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      publicUrl: "https://env.test", apiToken: "env-token", adminPassword: "file-password", port: 9999,
      dataDir: join(home, "data"), timeZone: "UTC",
    });
  });

  test("missing config suggests init without requiring server imports", async () => {
    const result = await configProcess(tempHome());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing required environment variable: PUBLIC_URL");
    expect(result.stderr).toContain("Run `sparky-mcp init` first");
  });
});

describe("init", () => {
  test("creates private config and directories without printing secrets", async () => {
    const home = tempHome();
    process.env.SPARKY_MCP_HOME = join(home, "new-home");
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
    try { await init({ publicUrl: "https://example.test/", yes: true, timezone: "UTC", port: "9000" }); }
    finally { log.mockRestore(); }
    const p = paths();
    const values = readEnv(p.config);
    expect(values.PUBLIC_URL).toBe("https://example.test");
    expect(values.API_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(values.ADMIN_PASSWORD).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(values.USER_TIMEZONE).toBe("UTC");
    expect(values.PORT).toBe("9000");
    expect(statSync(p.config).mode & 0o777).toBe(0o600);
    for (const dir of [p.home, p.data, p.logs]) expect(statSync(dir).mode & 0o777).toBe(0o700);
    const stdout = output.join("\n");
    expect(stdout).not.toContain(values.API_TOKEN!);
    expect(stdout).not.toContain(values.ADMIN_PASSWORD!);
    expect(stdout).toContain("sparky-mcp start");
    expect(stdout).toContain("sparky-mcp info");
    expect(stdout).toContain("sparky-mcp doctor");
  });

  test("refuses overwrite without force and preserves existing secrets", async () => {
    process.env.SPARKY_MCP_HOME = tempHome();
    await initialize({ publicUrl: "https://example.test", yes: true });
    const before = readFileSync(paths().config, "utf8");
    await expect(initialize({ publicUrl: "https://changed.test", yes: true })).rejects.toThrow("--force");
    expect(readFileSync(paths().config, "utf8")).toBe(before);
    await initialize({ publicUrl: "https://changed.test", yes: true, force: true });
    expect(readEnv().PUBLIC_URL).toBe("https://changed.test");
  });

  test("imports existing secrets and settings while flags override settings", async () => {
    const home = tempHome();
    process.env.SPARKY_MCP_HOME = join(home, "imported-home");
    const file = join(home, "existing.env");
    writeEnv(file, {
      PUBLIC_URL: "https://import.test", API_TOKEN: "existing-token", ADMIN_PASSWORD: "existing-password",
      USER_TIMEZONE: "America/Sao_Paulo", PORT: "9001", UNRELATED: "ignored",
    });
    await initialize({ importEnv: file, yes: true });
    expect(readEnv()).toEqual({
      PUBLIC_URL: "https://import.test", API_TOKEN: "existing-token", ADMIN_PASSWORD: "existing-password",
      USER_TIMEZONE: "America/Sao_Paulo", PORT: "9001",
    });
    await initialize({ importEnv: file, yes: true, force: true, publicUrl: "https://flag.test", timezone: "UTC", port: "9002" });
    expect(readEnv()).toEqual({
      PUBLIC_URL: "https://flag.test", API_TOKEN: "existing-token", ADMIN_PASSWORD: "existing-password", USER_TIMEZONE: "UTC", PORT: "9002",
    });
  });

  test("invalid init input does not create config", async () => {
    process.env.SPARKY_MCP_HOME = tempHome();
    for (const options of [{ publicUrl: "http://example.test" }, { publicUrl: "https://example.test", port: "0" }, { publicUrl: "https://example.test", timezone: "Invalid/Zone" }]) {
      await expect(initialize({ ...options, yes: true })).rejects.toThrow();
      expect(existsSync(paths().config)).toBe(false);
    }
  });
});

describe("service definitions", () => {
  test("systemd unit uses quoted executable, private home, and restart policy", () => {
    const unit = systemdUnit("/opt/Sparky MCP/sparky-mcp", "/home/user/private home");
    expect(unit).toContain('ExecStart="/opt/Sparky MCP/sparky-mcp" serve');
    expect(unit).toContain('Environment="SPARKY_MCP_HOME=/home/user/private home"');
    expect(unit).toContain("Restart=always\nRestartSec=2");
    expect(unit).toContain("WantedBy=default.target");
    expect(systemdUnit("/opt/100%/$bin", "/home/user")).toContain('ExecStart="/opt/100%%/$$bin" serve');
    expect(() => systemdUnit("/bad\npath", "/home/user")).toThrow();
  });

  test("LaunchAgent escapes XML and configures foreground server and shared log", () => {
    const plist = launchAgent("/opt/Sparky & MCP/sparky-mcp", "/Users/test/private<home>");
    expect(plist).toContain("<string>/opt/Sparky &amp; MCP/sparky-mcp</string><string>serve</string>");
    expect(plist).toContain("<key>Label</key><string>com.sparky.mcp</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>SPARKY_MCP_HOME</key><string>/Users/test/private&lt;home&gt;</string>");
    expect(plist.match(/private&lt;home&gt;\/logs\/server\.log/g)).toHaveLength(2);
  });
});

describe("info", () => {
  test("masks by default and reveals only when requested", () => {
    expect(mask("secret-token-1234")).toBe("••••1234");
    expect(mask("secret-token-1234", true)).toBe("secret-token-1234");
    expect(mask("")).toBe("Not configured");
    const values = { PUBLIC_URL: "https://example.test/", API_TOKEN: "token-1234", ADMIN_PASSWORD: "password-5678" };
    const fields = infoFields(values, "active", null);
    expect(fields.Connector).toBe("https://example.test/mcp");
    expect(fields.Local).toBe("http://127.0.0.1:8787");
    expect(fields["Last app sync"]).toBe("Never");
    expect(fields.API_TOKEN).toBe("••••1234");
    expect(fields.ADMIN_PASSWORD).toBe("••••5678");
    expect(infoFields(values, "active", null, true).API_TOKEN).toBe(values.API_TOKEN);
    expect(infoFields(values, "active", null, true).ADMIN_PASSWORD).toBe(values.ADMIN_PASSWORD);
  });

  test("reads mirror sync from SQLite without creating a missing database", () => {
    const file = join(tempHome(), "sparky-mcp.db");
    expect(databaseInfo(file)).toEqual({ opens: false, syncedAt: null });
    expect(existsSync(file)).toBe(false);
    const db = new Database(file);
    const syncedAt = "2026-10-01T12:00:00.000Z";
    db.exec("CREATE TABLE mirror (key TEXT PRIMARY KEY, value TEXT)");
    db.query("INSERT INTO mirror (key, value) VALUES (?, ?)").run("main", JSON.stringify({ syncedAt }));
    db.close();
    expect(databaseInfo(file)).toEqual({ opens: true, syncedAt });
  });
});

function fakeProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  const now = Date.parse("2026-10-01T12:00:00.000Z");
  return {
    platform: "linux", user: "test-user", now: () => now,
    async config() { return { exists: true, mode: 0o600, values: { PUBLIC_URL: "https://host.ts.net", API_TOKEN: "private-token", ADMIN_PASSWORD: "private-password" }, port: "8787", data: "/private/data" }; },
    async service() { return { installed: true, state: "active" }; },
    async health() { return true; },
    async database() { return { opens: true, syncedAt: new Date(now).toISOString() }; },
    async run(args) {
      if (args[0] === "loginctl") return { code: 0, stdout: "Linger=yes\n", stderr: "" };
      if (args[1] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "host.ts.net." } }), stderr: "" };
      return { code: 0, stdout: "https://host.ts.net (Funnel on)", stderr: "" };
    },
    ...overrides,
  };
}

describe("doctor", () => {
  test("healthy setup passes with a public Funnel warning and no secrets", async () => {
    const checks = await diagnose(fakeProbes());
    expect(checks.some((check) => check.state === "FAIL")).toBe(false);
    expect(checks.find((check) => check.label === "Funnel")?.state).toBe("WARN");
    expect(JSON.stringify(checks)).not.toContain("private-token");
    expect(JSON.stringify(checks)).not.toContain("private-password");
  });

  test("public hairpin failure, disabled linger, and stale mirror are warnings", async () => {
    const probes = fakeProbes({
      async health(url) { return url.startsWith("http://127.0.0.1"); },
      async database() { return { opens: true, syncedAt: "2026-09-29T12:00:00.000Z" }; },
    });
    const run = probes.run;
    probes.run = async (args) => args[0] === "loginctl" ? { code: 0, stdout: "Linger=no", stderr: "" } : run(args);
    const checks = await diagnose(probes);
    for (const label of ["Public health", "User linger", "Mirror freshness"]) expect(checks.find((check) => check.label === label)?.state).toBe("WARN");
    expect(checks.find((check) => check.label === "User linger")?.detail).toContain("loginctl enable-linger test-user");
    expect(checks.find((check) => check.label === "Mirror freshness")?.detail).toContain("Sync now");
    expect(checks.some((check) => check.state === "FAIL")).toBe(false);
  });

  test("missing config, stopped service, unavailable binaries, and database produce actionable failures", async () => {
    const checks = await diagnose(fakeProbes({
      async config() { return { exists: false, mode: 0, values: {}, port: "8787", data: "/missing" }; },
      async service() { return { installed: false, state: "inactive" }; },
      async run() { throw new Error("Binary absent"); },
      async health() { return false; },
      async database() { return { opens: false, syncedAt: null }; },
    }));
    for (const label of ["Config file", "Config permissions", "Required keys", "Public URL", "Service installed", "Service active", "Local health", "Database", "Tailscale", "Funnel"]) {
      expect(checks.find((check) => check.label === label)?.state).toBe("FAIL");
    }
    expect(checks.find((check) => check.label === "Funnel")?.detail).toContain("sudo tailscale funnel --bg 8787");
    expect(checks.find((check) => check.label === "Mirror freshness")?.state).toBe("WARN");
  });
});

describe("updates", () => {
  test("selects all supported assets and rejects unsupported platforms", () => {
    for (const os of ["linux", "darwin"]) for (const arch of ["x64", "arm64"]) expect(assetName(os, arch)).toBe(`sparky-mcp-${os}-${arch}`);
    expect(() => assetName("win32", "x64")).toThrow();
    expect(() => assetName("linux", "ia32")).toThrow();
  });

  test("verifies matching asset checksum and rejects corruption or ambiguous sums", () => {
    const data = new TextEncoder().encode("compiled binary fixture");
    const hash = createHash("sha256").update(data).digest("hex");
    const name = "sparky-mcp-linux-x64";
    expect(() => verifyChecksum(data, `${hash}  ${name}\n`, name)).not.toThrow();
    expect(() => verifyChecksum(data, `${hash.toUpperCase()} *${name}\r\n`, name)).not.toThrow();
    expect(() => verifyChecksum(new TextEncoder().encode("corrupt"), `${hash}  ${name}`, name)).toThrow("Checksum mismatch");
    expect(() => verifyChecksum(data, `${hash}  another-asset`, name)).toThrow("Missing or ambiguous");
    expect(() => verifyChecksum(data, `${hash}  ${name}\n${hash}  ${name}`, name)).toThrow("Missing or ambiguous");
  });

  test("compares release and prerelease versions numerically", () => {
    expect(compareVersions("v1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0+build", "1.0.0")).toBe(0);
    expect(() => compareVersions("dev", "1.0.0")).toThrow();
  });
});
