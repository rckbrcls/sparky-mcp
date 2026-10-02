import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixDoctor, fixProbes, type DoctorProbes } from "../src/cli/doctor.js";
import { writeEnv } from "../src/cli/envfile.js";

function fake(home: string): DoctorProbes {
  return {
    platform: "linux", user: "test-user", now: Date.now,
    config: async () => ({ exists: true, mode: statSync(join(home, "config.env")).mode & 0o777, values: { PUBLIC_URL: "https://host.test", API_TOKEN: "private-token", ADMIN_PASSWORD: "private-password" }, port: "8787", data: join(home, "data") }),
    service: async () => ({ installed: false, state: "inactive" }),
    health: async () => true, database: async () => ({ opens: true, syncedAt: new Date().toISOString() }),
    run: async (args) => ({ code: 0, stderr: "", stdout: args[0] === "loginctl" ? "Linger=no" : args[1] === "status" ? '{"BackendState":"NeedsLogin"}' : "" }),
  };
}

test("fix applies chmod and mkdir and leaves account/sudo fixes as hints", async () => {
  const home = mkdtempSync(join(tmpdir(), "sparky-fix-"));
  try {
    writeEnv(join(home, "config.env"), { API_TOKEN: "private-token" });
    chmodSync(join(home, "config.env"), 0o644);
    const probes = fake(home);
    const calls: string[][] = [];
    const original = probes.run;
    probes.run = async (args) => { calls.push(args); return args[1] === "enable-linger" ? { code: 1, stdout: "", stderr: "sudo required" } : original(args); };
    let started = false;
    const result = await fixDoctor({ yes: true }, probes, {
      ...fixProbes,
      paths: () => ({ home, config: join(home, "config.env"), data: join(home, "data"), logs: join(home, "logs"), log: join(home, "logs/server.log") }),
      start: async () => { started = true; },
    });
    expect(statSync(join(home, "config.env")).mode & 0o777).toBe(0o600);
    for (const dir of ["data", "logs"]) expect(statSync(join(home, dir)).mode & 0o777).toBe(0o700);
    expect(started).toBe(true);
    expect(result.fixed).toContain("Config permissions (0600)");
    expect(result.checks.find((check) => check.label === "Config permissions")?.state).toBe("PASS");
    expect(result.hints.join(" ")).toContain("loginctl enable-linger test-user");
    expect(result.hints).toContain("Run sparky-mcp funnel on.");
    expect(calls.every((args) => args[0] !== "sudo" && args[1] !== "login" && args[2] !== "--bg")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-token");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("linger and service fixes require confirmation and decline skips mutations", async () => {
  const home = mkdtempSync(join(tmpdir(), "sparky-fix-"));
  try {
    writeEnv(join(home, "config.env"), {});
    const probes = fake(home);
    const questions: string[] = [];
    const paths = () => ({ home, config: join(home, "config.env"), data: join(home, "data"), logs: join(home, "logs"), log: join(home, "logs/server.log") });
    await expect(fixDoctor({}, probes, { ...fixProbes, paths, confirm: async () => { throw new Error("Pass --yes to confirm."); } })).rejects.toThrow("Pass --yes");
    await fixDoctor({}, probes, {
      ...fixProbes, paths, confirm: async (text) => { questions.push(text); return false; },
      start: async () => { throw new Error("Must not start"); },
    });
    expect(questions).toEqual(["Run loginctl enable-linger test-user?", "Run sparky-mcp start?"]);
    expect(existsSync(join(home, "data"))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("service start alone requires confirmation", async () => {
  const home = mkdtempSync(join(tmpdir(), "sparky-fix-"));
  try {
    writeEnv(join(home, "config.env"), {});
    const probes = fake(home);
    probes.platform = "darwin";
    let started = false;
    await expect(fixDoctor({}, probes, {
      ...fixProbes,
      paths: () => ({ home, config: join(home, "config.env"), data: join(home, "data"), logs: join(home, "logs"), log: join(home, "logs/server.log") }),
      confirm: async (question) => { expect(question).toBe("Run sparky-mcp start?"); throw new Error("Pass --yes to confirm."); },
      start: async () => { started = true; },
    })).rejects.toThrow("Pass --yes");
    expect(started).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
