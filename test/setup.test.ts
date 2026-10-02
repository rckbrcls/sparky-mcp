import { expect, spyOn, test } from "bun:test";
import { runSetup, setup, type SetupProbes, type SetupEvent } from "../src/cli/setup.js";
import type { InitOptions } from "../src/cli/init.js";

function fake(overrides: Partial<SetupProbes> = {}) {
  const events: SetupEvent[] = [];
  const effects: string[] = [];
  const initialized: InitOptions[] = [];
  let exists = false;
  let active = false;
  let funnel = false;
  let now = 0;
  const probes: SetupProbes = {
    platform: "linux", tty: false,
    config: () => ({ exists, publicUrl: exists ? "https://host.ts.net" : "", port: "8787" }),
    tailscale: async () => ({ installed: true, dns: "host.ts.net" }),
    initialize: async (options) => { initialized.push(options); effects.push("initialize"); exists = true; },
    serviceState: async () => active ? "active" : "inactive",
    start: async () => { effects.push("start"); active = true; },
    health: async () => true,
    funnelStatus: async () => funnel,
    enableFunnel: async () => { effects.push("funnel"); funnel = true; },
    diagnose: async () => [{ label: "Local health", state: "PASS", detail: "Healthy." }],
    pair: async () => { effects.push("pair"); return true; },
    connect: async (target) => { effects.push(target); return { message: "Connected." }; },
    ask: async () => "6",
    confirm: async () => false,
    timezone: () => "UTC", now: () => now,
    sleep: async (ms) => { now += ms; },
    emit: (event) => { events.push(event); },
    ...overrides,
  };
  return { probes, events, effects, initialized, text: () => events.filter((event) => event.kind === "message").map((event) => event.text).join("\n") };
}

test("fresh non-interactive setup uses defaults, completes all steps and never reveals secrets", async () => {
  const f = fake();
  const result = await runSetup({ yes: true }, f.probes);
  expect(result.connectorUrl).toBe("https://host.ts.net/mcp");
  expect(result.completed).toHaveLength(5);
  expect(f.initialized).toEqual([{ publicUrl: "https://host.ts.net", timezone: "UTC", port: "8787", yes: true }]);
  expect(f.effects).toEqual(["initialize", "start"]);
  expect(f.events.filter((event) => event.kind === "step").map((event) => event.n)).toEqual([1, 2, 3, 4, 5]);
  expect(f.text()).not.toContain("ADMIN_PASSWORD");
});

test("existing configuration is never overwritten, even with a different public URL", async () => {
  const f = fake({ config: () => ({ exists: true, publicUrl: "https://existing.test", port: "9000" }) });
  const result = await runSetup({ yes: true, publicUrl: "https://replacement.test" }, f.probes);
  expect(result.connectorUrl).toBe("https://existing.test/mcp");
  expect(f.initialized).toHaveLength(0);
  expect(f.text()).toContain("Using existing configuration");
});

test("--yes alone never enables Funnel while explicit --funnel does", async () => {
  for (const funnel of [false, true]) {
    const f = fake({ confirm: async () => { throw new Error("No prompts allowed"); } });
    await runSetup({ yes: true, funnel }, f.probes);
    expect(f.effects.includes("funnel")).toBe(funnel);
  }
});

test("--no-funnel never asks for or enables Funnel", async () => {
  const f = fake({ tty: true, confirm: async (question) => {
    expect(question).not.toContain("Funnel");
    return true;
  } });
  await runSetup({ noFunnel: true }, f.probes);
  expect(f.effects).not.toContain("funnel");
});

test("missing Tailscale requires a custom URL and explains installation", async () => {
  const f = fake({ tailscale: async () => ({ installed: false, dns: "" }) });
  await expect(runSetup({ yes: true }, f.probes)).rejects.toThrow("--public-url");
  expect(f.text()).toContain("https://tailscale.com/download");
  expect(f.effects).toHaveLength(0);
  await runSetup({ yes: true, publicUrl: "https://proxy.test" }, f.probes);
  expect(f.initialized[0]?.publicUrl).toBe("https://proxy.test");
});

test("logged-out Tailscale permits entering a custom URL interactively", async () => {
  const f = fake({ tty: true, tailscale: async () => ({ installed: true, dns: "" }), confirm: async () => true,
    ask: async (question) => question.startsWith("Continue") ? "https://proxy.test" : "6" });
  await runSetup({}, f.probes);
  expect(f.text()).toContain("tailscale login");
  expect(f.initialized[0]?.publicUrl).toBe("https://proxy.test");
});

test("service health failure stops before Funnel and verification with a log hint", async () => {
  const f = fake({ health: async () => false });
  await expect(runSetup({ yes: true, funnel: true }, f.probes)).rejects.toThrow("sparky-mcp logs");
  expect(f.effects).toEqual(["initialize", "start"]);
  expect(f.events.filter((event) => event.kind === "step")).toHaveLength(3);
});

test("service startup failure includes the log hint", async () => {
  const f = fake({ start: async () => { throw new Error("start failed"); } });
  await expect(runSetup({ yes: true }, f.probes)).rejects.toThrow("sparky-mcp logs");
});

test("non-TTY without --yes fails before probing or effects", async () => {
  const f = fake({ tailscale: async () => { throw new Error("Must not probe"); } });
  await expect(runSetup({}, f.probes)).rejects.toThrow("setup is interactive; pass --yes for non-interactive defaults");
  expect(f.events).toHaveLength(0);
});

test("interactive menu is repeatable, connects targets and skips duplicate completed actions", async () => {
  const choices = ["1", "1", "2", "3", "4", "5", "6"];
  const f = fake({ tty: true, confirm: async () => true, ask: async () => choices.shift()! });
  const result = await runSetup({}, f.probes);
  expect(result.connected).toEqual(["Sparky app", "claude-code", "codex", "claude-web", "chatgpt"]);
  expect(f.effects.filter((effect) => effect === "pair")).toHaveLength(1);
  expect(f.text()).toContain("already done");
});

test("--no-pair removes the pairing option and --yes skips the menu", async () => {
  const choices = ["1", "6"];
  const f = fake({ tty: true, confirm: async () => true, ask: async () => choices.shift()! });
  await runSetup({ noPair: true }, f.probes);
  expect(f.text()).not.toContain("1 Pair");
  expect(f.effects).not.toContain("pair");
  await runSetup({ yes: true }, fake({ tty: true, ask: async () => { throw new Error("Must not ask"); } }).probes);
});

test("idempotent re-run retains configuration, active service and Funnel", async () => {
  const f = fake();
  await runSetup({ yes: true, funnel: true }, f.probes);
  f.effects.length = 0;
  await runSetup({ yes: true, funnel: true }, f.probes);
  expect(f.effects).toHaveLength(0);
  expect(f.text()).toContain("Service is active (already done)");
  expect(f.text()).toContain("Funnel is already on (already done)");
});

test("abort during a pending operation exits immediately and prevents later steps", async () => {
  const controller = new AbortController();
  const f = fake({ start: async () => {
    controller.abort(new DOMException("Interrupted", "AbortError"));
    return new Promise(() => {});
  } });
  await expect(runSetup({ yes: true, funnel: true }, f.probes, controller.signal)).rejects.toThrow("Interrupted");
  expect(f.events.filter((event) => event.kind === "step")).toHaveLength(3);
  expect(f.effects).toEqual(["initialize"]);
});

test("abort while prompting prevents configuration writes and later menu actions", async () => {
  const controller = new AbortController();
  const f = fake({ tty: true, confirm: async () => {
    controller.abort(new DOMException("Interrupted", "AbortError"));
    return true;
  } });
  await expect(runSetup({}, f.probes, controller.signal)).rejects.toThrow("Interrupted");
  expect(f.effects).toHaveLength(0);
});

test("SIGINT prints the resumable interruption message, sets 130 and removes its listener", async () => {
  const saved = process.exitCode;
  const listeners = process.listenerCount("SIGINT");
  const output = spyOn(console, "log").mockImplementation(() => {});
  const f = fake({ start: async () => { process.emit("SIGINT"); return new Promise(() => {}); } });
  try {
    await setup({ yes: true, funnel: true }, f.probes);
    expect(process.exitCode).toBe(130);
    expect(output).toHaveBeenCalledWith("Setup interrupted. Completed steps are kept; run sparky-mcp setup again to continue.");
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(f.effects).toEqual(["initialize"]);
  } finally { output.mockRestore(); process.exitCode = saved ?? 0; }
});

test("contradictory Funnel flags and unsupported platforms fail safely", async () => {
  await expect(runSetup({ yes: true, funnel: true, noFunnel: true }, fake().probes)).rejects.toThrow("Choose --funnel");
  const f = fake({ platform: "win32" });
  await expect(runSetup({ yes: true }, f.probes)).rejects.toThrow("Linux and macOS");
  expect(f.effects).toHaveLength(0);
});
