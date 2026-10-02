import { init } from "./cli/init.js";
import { serve } from "./cli/serve.js";
import { start } from "./cli/start.js";
import { stop } from "./cli/stop.js";
import { restart } from "./cli/restart.js";
import { status } from "./cli/status.js";
import { logs } from "./cli/logs.js";
import { pair } from "./cli/pair.js";
import { info } from "./cli/info.js";
import { doctor } from "./cli/doctor.js";
import { update } from "./cli/update.js";
import { funnel } from "./cli/funnel.js";
import { connect } from "./cli/connect.js";
import { version } from "./cli/version.js";

const usage = `Usage: sparky-mcp <command> [flags]

  init      Set up config and secrets
            --public-url URL --timezone TZ --port N --import-env FILE --force --yes
  serve     Run the server in the foreground
  start     Install and start the user service
  stop      Stop the user service
  restart   Restart the user service
  status    Show service state and local health
  logs      Show service logs [-f]
  pair      Pair the Sparky app [--no-wait]
  info      Show connection details [--reveal] [--copy token|password]
  funnel    Manage public access: on|off|status [--yes]
  connect   Connect claude-code|codex|claude-web|chatgpt [--url URL] [--token-stdin]
  doctor    Check configuration and connectivity [--fix] [--yes]
  update    Install the latest release [--check]
  version   Show version

  --help    Show this help
  --version Show version`;

function flags(args: string[], allowed: Record<string, "value" | "boolean">) {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const kind = allowed[arg];
    if (!kind) throw new Error(`Unknown flag: ${arg}. Use --help for usage.`);
    if (result[arg] !== undefined) throw new Error(`Duplicate flag: ${arg}.`);
    if (kind === "boolean") result[arg] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${arg}.`);
      result[arg] = value;
    }
  }
  return result;
}

async function main(args: string[]) {
  if (!args.length || args.includes("--help")) { console.log(usage); return; }
  const [command, ...rest] = args;
  if (command === "--version" || command === "version") { flags(rest, {}); console.log(version); return; }
  if (command === "init") {
    const f = flags(rest, { "--public-url": "value", "--timezone": "value", "--port": "value", "--import-env": "value", "--force": "boolean", "--yes": "boolean" });
    await init({ publicUrl: f["--public-url"] as string | undefined, timezone: f["--timezone"] as string | undefined, port: f["--port"] as string | undefined, importEnv: f["--import-env"] as string | undefined, force: Boolean(f["--force"]), yes: Boolean(f["--yes"]) });
  } else if (command === "pair") {
    const f = flags(rest, { "--no-wait": "boolean" });
    await pair({ noWait: Boolean(f["--no-wait"]) });
  } else if (command === "info") {
    const f = flags(rest, { "--reveal": "boolean", "--copy": "value" });
    const copy = f["--copy"];
    if (copy !== undefined && copy !== "token" && copy !== "password") throw new Error("--copy expects token or password.");
    await info({ reveal: Boolean(f["--reveal"]), copy });
  } else if (command === "funnel") {
    const [action, ...args] = rest;
    const f = flags(args, { "--yes": "boolean" });
    await funnel(action || "", { yes: Boolean(f["--yes"]) });
  } else if (command === "connect") {
    const [target, ...args] = rest;
    const f = flags(args, { "--url": "value", "--token-stdin": "boolean" });
    await connect(target || "", { url: f["--url"] as string | undefined, tokenStdin: Boolean(f["--token-stdin"]) });
  } else if (command === "doctor") {
    const f = flags(rest, { "--fix": "boolean", "--yes": "boolean" });
    await doctor({ fix: Boolean(f["--fix"]), yes: Boolean(f["--yes"]) });
  } else if (command === "logs") {
    const f = flags(rest, { "-f": "boolean" });
    await logs(Boolean(f["-f"]));
  } else if (command === "update") {
    const f = flags(rest, { "--check": "boolean" });
    await update(Boolean(f["--check"]));
  } else {
    const commands: Record<string, () => Promise<void>> = { serve, start, stop, restart, status };
    const action = commands[command!];
    if (!action) throw new Error(`Unknown command: ${command}. Use --help for usage.`);
    flags(rest, {});
    await action();
  }
}

try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
}
