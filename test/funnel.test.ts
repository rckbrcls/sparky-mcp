import { expect, test } from "bun:test";
import { funnelFields, getFunnelStatus, manageFunnel, parseFunnel, type FunnelProbes } from "../src/cli/funnel.js";

function fake(overrides: Partial<FunnelProbes> = {}): FunnelProbes {
  return {
    config: () => ({ exists: true, values: { PORT: "9000", PUBLIC_URL: "https://other.test" } }),
    async run(args) {
      return { code: 0, stderr: "", stdout: args[1] === "status" ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "host.ts.net." } }) : "https://host.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:9000" };
    },
    confirm: async () => true, wait: async () => "", tty: false, message: () => {}, ...overrides,
  };
}

test("status parses only this host and reports a mismatch", async () => {
  const result = await getFunnelStatus(fake());
  expect(result).toEqual({ dns: "host.ts.net", url: "https://host.ts.net", active: true, port: "9000", matches: false });
  expect(funnelFields(result).PUBLIC_URL).toContain("init --force --public-url https://host.ts.net");
  expect(parseFunnel("https://other.test (Funnel on)\nproxy http://localhost:8000", "host.ts.net")).toEqual({ active: false, port: null });
  expect(parseFunnel("https://host.ts.net (tailnet only)\nproxy http://localhost:8000", "host.ts.net").active).toBe(false);
});

test("on requires confirmation without a terminal", async () => {
  await expect(manageFunnel("on", {}, fake())).rejects.toThrow("Pass --yes");
});

test("permission failure alone triggers inherited sudo and off has exact arguments", async () => {
  const calls: { args: string[]; inherit?: boolean }[] = [];
  const probes = fake();
  const original = probes.run;
  probes.run = async (args, options) => {
    calls.push({ args, inherit: options?.inherit });
    if (args[0] === "tailscale" && args[2] === "--https=443") return { code: 1, stdout: "", stderr: "Access denied: operator required" };
    return original(args, options);
  };
  await manageFunnel("off", { yes: true }, probes);
  expect(calls[1]?.args).toEqual(["tailscale", "funnel", "--https=443", "off"]);
  expect(calls[2]).toEqual({ args: ["sudo", "tailscale", "funnel", "--https=443", "off"], inherit: true });
  calls.length = 0;
  probes.run = async (args, options) => {
    calls.push({ args, inherit: options?.inherit });
    return args[2] === "--bg" ? { code: 1, stdout: "", stderr: "Invalid configuration" } : original(args, options);
  };
  await expect(manageFunnel("on", { yes: true }, probes)).rejects.toThrow("Funnel command failed");
  expect(calls.some((call) => call.args[0] === "sudo")).toBe(false);
});

test("approval URL is surfaced and command reruns after approval", async () => {
  const messages: string[] = [];
  let attempts = 0;
  let waited = false;
  const probes = fake({ tty: true, message: (text) => { messages.push(text); }, wait: async () => { waited = true; return ""; } });
  const original = probes.run;
  probes.run = async (args, options) => args[2] === "--bg" && attempts++ === 0 ? { code: 1, stderr: "", stdout: "Approve https://login.tailscale.com/f/approval" } : original(args, options);
  await manageFunnel("on", { yes: true }, probes);
  expect(attempts).toBe(2);
  expect(waited).toBe(true);
  expect(messages.join("\n")).toContain("https://login.tailscale.com/f/approval");
});

test("missing or logged out Tailscale and missing config fail clearly", async () => {
  await expect(getFunnelStatus(fake({ run: async () => ({ code: 127, stdout: "", stderr: "" }) }))).rejects.toThrow("unavailable");
  await expect(getFunnelStatus(fake({ run: async () => ({ code: 0, stdout: '{"BackendState":"NeedsLogin"}', stderr: "" }) }))).rejects.toThrow("tailscale login");
  await expect(manageFunnel("on", { yes: true }, fake({ config: () => ({ exists: false, values: {} }) }))).rejects.toThrow("init");
});

test("successful on reports matching PUBLIC_URL without sudo", async () => {
  const probes = fake({ config: () => ({ exists: true, values: { PORT: "9000", PUBLIC_URL: "https://host.ts.net" } }) });
  const calls: string[][] = [];
  const original = probes.run;
  probes.run = async (args, options) => { calls.push(args); return original(args, options); };
  const result = await manageFunnel("on", { yes: true }, probes);
  expect(result.matches).toBe(true);
  expect(calls).toContainEqual(["tailscale", "funnel", "--bg", "9000"]);
  expect(calls.some((args) => args[0] === "sudo")).toBe(false);
});

test("declining confirmation never invokes Funnel mutation", async () => {
  const calls: string[][] = [];
  const probes = fake({ tty: true, confirm: async () => false });
  const original = probes.run;
  probes.run = async (args, options) => { calls.push(args); return original(args, options); };
  await expect(manageFunnel("on", {}, probes)).rejects.toThrow("Cancelled");
  expect(calls).toHaveLength(1);
});
