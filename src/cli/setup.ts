import { existsSync } from "node:fs";
import { paths } from "./paths.js";
import { readEnv, publicUrl, validPort } from "./envfile.js";
import { initialize, type InitOptions } from "./init.js";
import { manageService, serviceState, serviceFile } from "./service.js";
import { getFunnelStatus, manageFunnel, funnelProbes, funnelWarning } from "./funnel.js";
import { diagnose, doctorProbes } from "./doctor.js";
import { pair, pairProbes } from "./pair.js";
import { connectorUrl, connectTarget, connectProbes } from "./connect.js";
import { line, confirm } from "./prompt.js";
import { run } from "./process.js";
import { box, step, spinner, printChecks, type Check } from "./ui.js";

export interface SetupOptions { yes?: boolean; publicUrl?: string; funnel?: boolean; noFunnel?: boolean; noPair?: boolean }
export type SetupEvent = { kind: "step"; n: number; title: string } | { kind: "message"; text: string } | { kind: "checks"; checks: Check[] } | { kind: "busy"; text: string } | { kind: "idle" };
export interface SetupProbes {
  platform: string;
  tty: boolean;
  config(): { exists: boolean; publicUrl: string; port: string };
  tailscale(signal: AbortSignal): Promise<{ installed: boolean; dns: string }>;
  initialize(options: InitOptions, signal: AbortSignal): Promise<unknown>;
  serviceState(signal: AbortSignal): Promise<string>;
  start(signal: AbortSignal): Promise<unknown>;
  health(port: string, signal: AbortSignal): Promise<boolean>;
  funnelStatus(signal: AbortSignal): Promise<boolean>;
  enableFunnel(signal: AbortSignal): Promise<unknown>;
  diagnose(signal: AbortSignal): Promise<Check[]>;
  pair(signal: AbortSignal): Promise<boolean>;
  connect(target: string, signal: AbortSignal): Promise<{ message: string }>;
  ask(question: string, signal: AbortSignal): Promise<string>;
  confirm(question: string, signal: AbortSignal): Promise<boolean>;
  timezone(): string;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<unknown>;
  emit(event: SetupEvent): void;
}

export function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException("Setup interrupted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function defaultSetupProbes(emit: SetupProbes["emit"]): SetupProbes {
  return {
    platform: process.platform,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb"),
    config() {
      const values = readEnv();
      return { exists: existsSync(paths().config), publicUrl: values.PUBLIC_URL || "", port: values.PORT || "8787" };
    },
    async tailscale(signal) {
      const result = await run(["tailscale", "status", "--json"], { timeout: 1500, signal });
      let dns = "";
      try {
        const status = JSON.parse(result.stdout);
        if (result.code === 0 && status.BackendState === "Running" && typeof status.Self?.DNSName === "string") dns = status.Self.DNSName.replace(/\.$/, "");
      } catch {}
      return { installed: result.code !== 127, dns };
    },
    initialize: (options) => initialize(options),
    serviceState: (signal) => serviceState(1500, signal),
    start: (signal) => manageService("start", signal),
    async health(port, signal) {
      try {
        const response = await fetch(`http://127.0.0.1:${validPort(port)}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(750)]) });
        return response.status === 200 && (await response.json() as { ok?: boolean }).ok === true;
      } catch { return false; }
    },
    funnelStatus: (signal) => getFunnelStatus({ ...funnelProbes, run: (args, options) => run(args, { ...options, timeout: 1500, signal }) }).then((result) => result.active).catch(() => false),
    enableFunnel: (signal) => manageFunnel("on", { yes: true }, {
      ...funnelProbes,
      run: (args, options) => run(args, { ...options, signal }),
      wait: (question) => line(question, signal),
      message: (text) => { if (!signal.aborted) emit({ kind: "message", text }); },
    }),
    diagnose: (signal) => diagnose({
      ...doctorProbes,
      config: () => abortable(() => doctorProbes.config(), signal),
      service: () => abortable(async () => ({ installed: existsSync(serviceFile()), state: await serviceState(1500, signal) }), signal),
      run: (args) => run(args, { signal }),
      health: (url) => abortable(() => doctorProbes.health(url), signal),
      database: (file) => abortable(() => doctorProbes.database(file), signal),
    }),
    pair: (signal) => pair({ signal }, { ...pairProbes, sleep: (ms) => abortable(() => Bun.sleep(ms), signal), message: (text) => { if (!signal.aborted) emit({ kind: "message", text }); } }),
    connect: (target, signal) => connectTarget(target, {}, {
      ...connectProbes,
      run: (args, options) => run(args, { ...options, signal }),
      wait: (question) => line(question, signal),
      confirm: (question, options) => confirm(question, { ...options, signal }),
      message: (text) => { if (!signal.aborted) emit({ kind: "message", text }); },
    }),
    ask: line,
    confirm: (question, signal) => confirm(question, { signal }),
    timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    emit,
  };
}

export async function runSetup(options: SetupOptions, probes: SetupProbes, signal = new AbortController().signal) {
  if (options.funnel && options.noFunnel) throw new Error("Choose --funnel or --no-funnel, not both.");
  if (!probes.tty && !options.yes) throw new Error("setup is interactive; pass --yes for non-interactive defaults");
  const invoke = <T>(operation: () => Promise<T>) => abortable(operation, signal);
  const emit = (event: SetupEvent) => { signal.throwIfAborted(); probes.emit(event); };
  const message = (text: string) => emit({ kind: "message", text });
  const completed: string[] = [];
  const connected: string[] = [];
  emit({ kind: "step", n: 1, title: "Prerequisites" });
  if (!["linux", "darwin"].includes(probes.platform)) throw new Error("Setup supports Linux and macOS only.");
  const tailscale = await invoke(() => probes.tailscale(signal));
  const existing = probes.config();
  let url = options.publicUrl || existing.publicUrl || (tailscale.dns ? `https://${tailscale.dns}` : "");
  if (!tailscale.dns) {
    message(tailscale.installed ? "Tailscale is not logged in. Run tailscale login." : "Tailscale is missing. Install it from https://tailscale.com/download, then run tailscale login.");
    if (!url && probes.tty && !options.yes) url = await invoke(() => probes.ask("Continue with your own public HTTPS URL (blank to stop): ", signal));
    if (!url) throw new Error("Provide --public-url https://your-host to continue without Tailscale.");
    message("Continuing with a custom URL. Configure your HTTPS proxy separately.");
  } else message("Tailscale installed and logged in (already done).");
  completed.push("Prerequisites");
  emit({ kind: "step", n: 2, title: "Configuration" });
  if (existing.exists) {
    message("Using existing configuration (already done).");
    url = publicUrl(existing.publicUrl);
  } else {
    url = publicUrl(url);
    let timezone = probes.timezone();
    let port = "8787";
    message(`URL: ${url}\nTime zone: ${timezone}\nPort: ${port}`);
    if (probes.tty && !options.yes && !await invoke(() => probes.confirm("Use these defaults?", signal))) {
      url = publicUrl(await invoke(() => probes.ask(`Public HTTPS URL [${url}]: `, signal)) || url);
      timezone = await invoke(() => probes.ask(`Time zone [${timezone}]: `, signal)) || timezone;
      port = validPort(await invoke(() => probes.ask("Port [8787]: ", signal)) || port);
    }
    await invoke(() => probes.initialize({ publicUrl: url, timezone, port, yes: true }, signal));
    message("Configuration created.");
  }
  completed.push("Configuration");
  emit({ kind: "step", n: 3, title: "Service" });
  const cfg = probes.config();
  emit({ kind: "busy", text: "Starting service" });
  try {
    if (await invoke(() => probes.serviceState(signal)) === "active") message("Service is active (already done).");
    else await invoke(() => probes.start(signal));
    const deadline = probes.now() + 10000;
    let healthy = false;
    for (let attempt = 0; attempt < 40 && probes.now() < deadline; attempt++) {
      if (await invoke(() => probes.health(cfg.port, signal))) { healthy = true; break; }
      if (probes.now() < deadline) await invoke(() => probes.sleep(Math.min(250, deadline - probes.now()), signal));
    }
    if (!healthy) throw new Error("Service did not become healthy. Check sparky-mcp logs, then run sparky-mcp setup again.");
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`Service setup failed. Check sparky-mcp logs. ${error instanceof Error ? error.message : "Run setup again."}`);
  } finally { if (!signal.aborted) emit({ kind: "idle" }); }
  message("Local health is OK.");
  completed.push("Service");
  emit({ kind: "step", n: 4, title: "Public access" });
  message("Skipping Funnel is fine for Sparky, Claude Code and Codex over the tailnet. Claude and ChatGPT web connectors need public access through Funnel.");
  const funnelOn = await invoke(() => probes.funnelStatus(signal));
  if (funnelOn) message("Funnel is already on (already done).");
  else {
    message(funnelWarning(url));
    const enable = !options.noFunnel && (Boolean(options.funnel) || (!options.yes && probes.tty && await invoke(() => probes.confirm("Turn on Funnel?", signal))));
    if (enable) { await invoke(() => probes.enableFunnel(signal)); message("Funnel enabled."); }
    else message("Funnel skipped. Existing public access settings are kept.");
  }
  completed.push("Public access");
  emit({ kind: "step", n: 5, title: "Verify and connect" });
  const checks = await invoke(() => probes.diagnose(signal));
  emit({ kind: "checks", checks });
  if (probes.tty && !options.yes) {
    const targets: Record<string, string> = { "2": "claude-code", "3": "codex", "4": "claude-web", "5": "chatgpt" };
    while (true) {
      message(`${options.noPair ? "" : "1 Pair the Sparky app\n"}2 Connect Claude Code\n3 Connect Codex\n4 Connect Claude (web)\n5 Connect ChatGPT (web)\n6 Done`);
      const choice = await invoke(() => probes.ask("Choose [6]: ", signal));
      if (!choice || choice === "6") break;
      try {
        if (choice === "1" && !options.noPair) {
          if (connected.includes("Sparky app")) message("Sparky app connected (already done).");
          else if (await invoke(() => probes.pair(signal))) connected.push("Sparky app");
        } else if (targets[choice]) {
          const target = targets[choice]!;
          if (connected.includes(target)) message(`${target} connected (already done).`);
          else { const result = await invoke(() => probes.connect(target, signal)); message(result.message); connected.push(target); }
        } else message("Choose a number from the menu.");
      } catch (error) {
        if (signal.aborted) throw error;
        message(error instanceof Error ? error.message : "Connection failed. Try again.");
      }
    }
  }
  completed.push("Verify and connect");
  return { connectorUrl: connectorUrl(url), connected, checks, completed };
}

export async function setup(options: SetupOptions = {}, supplied?: SetupProbes) {
  const controller = new AbortController();
  let busy: ReturnType<typeof spinner> | undefined;
  const stop = () => { busy?.stop(); busy = undefined; };
  const interrupt = () => { controller.abort(new DOMException("Setup interrupted.", "AbortError")); stop(); };
  process.on("SIGINT", interrupt);
  try {
    const probes = supplied || defaultSetupProbes((event) => {
      if (event.kind === "step") { stop(); step(event.n, 5, event.title); }
      else if (event.kind === "message") { stop(); console.log(event.text); }
      else if (event.kind === "checks") printChecks(event.checks, true);
      else if (event.kind === "busy") { stop(); busy = spinner(event.text); }
      else stop();
    });
    const result = await runSetup(options, probes, controller.signal);
    console.log(box("Setup complete", [`Connector URL: ${result.connectorUrl}`, `Connected: ${result.connected.join(", ") || "None yet"}`, "Reveal secrets: sparky-mcp info --reveal", "Next commands: sparky-mcp status, sparky-mcp doctor, sparky-mcp help"]));
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    console.log("Setup interrupted. Completed steps are kept; run sparky-mcp setup again to continue.");
    process.exitCode = 130;
  } finally { stop(); process.removeListener("SIGINT", interrupt); }
}
