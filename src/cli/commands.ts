export type CommandFlags = Record<string, string | boolean>;
export type CommandGroup = "Get started" | "Run" | "Connect" | "Maintain";
export interface CommandFlag { name: string; value?: string; description: string }
export interface Command {
  name: string;
  group: CommandGroup;
  summary: string;
  usage: string[];
  flags: CommandFlag[];
  examples: string[];
  notes?: string[];
  positional?: boolean;
  run(flags: CommandFlags, argument: string): Promise<void>;
}

const helpFlags: CommandFlag[] = [
  { name: "--help", description: "Show help for this command." },
  { name: "-h", description: "Show help for this command." },
];
const text = (flags: CommandFlags, name: string) => flags[name] as string | undefined;
const yes = (flags: CommandFlags, name: string) => Boolean(flags[name]);
function command(value: Command): Command { return { ...value, flags: [...value.flags, ...helpFlags] }; }

export const commands: Command[] = [
  command({
    name: "setup", group: "Get started", summary: "Set up and connect Sparky with a guided wizard.",
    usage: ["sparky-mcp setup [flags]"],
    flags: [
      { name: "--yes", description: "Use non-interactive defaults; does not enable Funnel." },
      { name: "--public-url", value: "URL", description: "Use this HTTPS public URL." },
      { name: "--funnel", description: "Explicitly enable public Funnel access." },
      { name: "--no-funnel", description: "Skip enabling Funnel." },
      { name: "--no-pair", description: "Skip the app pairing option." },
    ],
    examples: ["sparky-mcp setup", "sparky-mcp setup --yes --public-url https://host.ts.net", "sparky-mcp setup --yes --funnel --no-pair"],
    notes: ["Existing configuration is preserved. Re-run setup to resume.", "Funnel exposes the server to the public internet. --yes alone never enables it."],
    async run(f) { await (await import("./setup.js")).setup({ yes: yes(f, "--yes"), publicUrl: text(f, "--public-url"), funnel: yes(f, "--funnel"), noFunnel: yes(f, "--no-funnel"), noPair: yes(f, "--no-pair") }); },
  }),
  command({
    name: "init", group: "Get started", summary: "Create configuration and private secrets.", usage: ["sparky-mcp init [flags]"],
    flags: [
      { name: "--public-url", value: "URL", description: "Set the HTTPS public URL." },
      { name: "--timezone", value: "TZ", description: "Set the IANA timezone." },
      { name: "--port", value: "N", description: "Set the local listening port (default: 8787)." },
      { name: "--import-env", value: "FILE", description: "Import settings and secrets from an env file." },
      { name: "--force", description: "Replace existing configuration." },
      { name: "--yes", description: "Accept non-interactive defaults." },
    ],
    examples: ["sparky-mcp init", "sparky-mcp init --yes --public-url https://host.ts.net --timezone UTC", "sparky-mcp init --import-env ./config.env"],
    notes: ["Configuration contains secrets. Keep config.env private.", "Use setup for a guided installation."],
    async run(f) { await (await import("./init.js")).init({ publicUrl: text(f, "--public-url"), timezone: text(f, "--timezone"), port: text(f, "--port"), importEnv: text(f, "--import-env"), force: yes(f, "--force"), yes: yes(f, "--yes") }); },
  }),
  command({ name: "start", group: "Run", summary: "Install and start the user service.", usage: ["sparky-mcp start"], flags: [], examples: ["sparky-mcp start", "sparky-mcp start && sparky-mcp status"], async run() { await (await import("./start.js")).start(); } }),
  command({ name: "stop", group: "Run", summary: "Stop the user service.", usage: ["sparky-mcp stop"], flags: [], examples: ["sparky-mcp stop", "sparky-mcp stop && sparky-mcp status"], async run() { await (await import("./stop.js")).stop(); } }),
  command({ name: "restart", group: "Run", summary: "Restart the user service.", usage: ["sparky-mcp restart"], flags: [], examples: ["sparky-mcp restart", "sparky-mcp restart && sparky-mcp doctor"], async run() { await (await import("./restart.js")).restart(); } }),
  command({ name: "status", group: "Run", summary: "Show service state and local health.", usage: ["sparky-mcp status"], flags: [], examples: ["sparky-mcp status", "sparky-mcp start && sparky-mcp status"], async run() { await (await import("./status.js")).status(); } }),
  command({ name: "logs", group: "Run", summary: "Show service logs.", usage: ["sparky-mcp logs [-f]"], flags: [{ name: "-f", description: "Follow new log entries." }], examples: ["sparky-mcp logs", "sparky-mcp logs -f"], async run(f) { await (await import("./logs.js")).logs(yes(f, "-f")); } }),
  command({ name: "serve", group: "Run", summary: "Run the server in the foreground.", usage: ["sparky-mcp serve"], flags: [], examples: ["sparky-mcp serve", "SPARKY_MCP_HOME=/path/to/home sparky-mcp serve"], notes: ["Use start for a background user service. Stop it before using the same port."], async run() { await (await import("./serve.js")).serve(); } }),
  command({ name: "pair", group: "Connect", summary: "Pair the Sparky app with this server.", usage: ["sparky-mcp pair [--no-wait]"], flags: [{ name: "--no-wait", description: "Print the pairing code without waiting for app sync." }], examples: ["sparky-mcp pair", "sparky-mcp pair --no-wait"], notes: ["Keep the temporary pairing code private."], async run(f) { await (await import("./pair.js")).pair({ noWait: yes(f, "--no-wait") }); } }),
  command({
    name: "connect", group: "Connect", summary: "Connect Claude Code, Codex, Claude or ChatGPT.", positional: true,
    usage: ["sparky-mcp connect <claude-code|codex|claude-web|chatgpt> [flags]"],
    flags: [{ name: "--url", value: "URL", description: "Use an explicit connector URL." }, { name: "--token-stdin", description: "Read the API token from standard input." }],
    examples: ["sparky-mcp connect claude-code", "sparky-mcp connect codex", "sparky-mcp connect chatgpt"],
    notes: ["Claude and ChatGPT web connectors require public access through Funnel.", "Claude Code receives the token as a process argument. Codex reads SPARKY_MCP_TOKEN at runtime."],
    async run(f, argument) { await (await import("./connect.js")).connect(argument, { url: text(f, "--url"), tokenStdin: yes(f, "--token-stdin") }); },
  }),
  command({
    name: "funnel", group: "Connect", summary: "Manage public internet access.", positional: true, usage: ["sparky-mcp funnel <on|off|status> [--yes]"],
    flags: [{ name: "--yes", description: "Confirm the public access change without a prompt." }],
    examples: ["sparky-mcp funnel status", "sparky-mcp funnel on", "sparky-mcp funnel off --yes"],
    notes: ["Funnel exposes /mcp and /api to the public internet. Keep your API token and admin password private.", "Tailnet access for Sparky, Claude Code and Codex works without Funnel."],
    async run(f, argument) { await (await import("./funnel.js")).funnel(argument, { yes: yes(f, "--yes") }); },
  }),
  command({
    name: "info", group: "Connect", summary: "Show connector details and masked secrets.", usage: ["sparky-mcp info [flags]"],
    flags: [{ name: "--reveal", description: "Print API token and admin password in full." }, { name: "--copy", value: "token|password", description: "Copy a secret to the clipboard." }],
    examples: ["sparky-mcp info", "sparky-mcp info --copy token", "sparky-mcp info --reveal"],
    notes: ["--reveal prints secrets. Avoid shared terminals, logs and screenshots."],
    async run(f) {
      const copy = f["--copy"];
      if (copy !== undefined && copy !== "token" && copy !== "password") throw new Error("--copy expects token or password. Run sparky-mcp help info.");
      await (await import("./info.js")).info({ reveal: yes(f, "--reveal"), copy });
    },
  }),
  command({ name: "doctor", group: "Maintain", summary: "Check configuration, service and connectivity.", usage: ["sparky-mcp doctor [flags]"], flags: [{ name: "--fix", description: "Offer supported repairs for detected issues." }, { name: "--yes", description: "Confirm supported repairs without a prompt." }], examples: ["sparky-mcp doctor", "sparky-mcp doctor --fix", "sparky-mcp doctor --fix --yes"], notes: ["Failures produce a non-zero exit code."], async run(f) { await (await import("./doctor.js")).doctor({ fix: yes(f, "--fix"), yes: yes(f, "--yes") }); } }),
  command({ name: "update", group: "Maintain", summary: "Check for or install the latest release.", usage: ["sparky-mcp update [--check]"], flags: [{ name: "--check", description: "Check the latest version without installing it." }], examples: ["sparky-mcp update --check", "sparky-mcp update"], notes: ["Release checks and downloads require internet access."], async run(f) { await (await import("./update.js")).update(yes(f, "--check")); } }),
  command({ name: "version", group: "Maintain", summary: "Show the installed version.", usage: ["sparky-mcp version", "sparky-mcp --version"], flags: [], examples: ["sparky-mcp version", "sparky-mcp --version"], async run() { console.log((await import("./version.js")).version); } }),
  command({ name: "help", group: "Maintain", summary: "Show an overview or command details.", positional: true, usage: ["sparky-mcp help [command]", "sparky-mcp <command> --help"], flags: [], examples: ["sparky-mcp help", "sparky-mcp help setup", "sparky-mcp funnel --help"], async run(_f, argument) { console.log((await import("./help.js")).renderHelp(argument || undefined)); } }),
];

export function findCommand(name: string): Command | undefined { return commands.find((command) => command.name === name); }
