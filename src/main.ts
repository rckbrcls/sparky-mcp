import { findCommand, type Command, type CommandFlags } from "./cli/commands.js";
import { renderHelp, unknownCommand } from "./cli/help.js";

export type Route = { kind: "summary" } | { kind: "help"; command?: string } | { kind: "command"; command: Command; flags: CommandFlags; argument: string };

export function parseFlags(command: Command, args: string[]): CommandFlags {
  const result: CommandFlags = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    const flag = command.flags.find((flag) => flag.name === name);
    const hint = `Run sparky-mcp help ${command.name}.`;
    if (!flag) throw new Error(`Unknown flag: ${name}. ${hint}`);
    if (result[name] !== undefined) throw new Error(`Duplicate flag: ${name}. ${hint}`);
    if (!flag.value) result[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${name}. ${hint}`);
      result[name] = value;
    }
  }
  return result;
}

export function route(args: string[]): Route {
  if (!args.length) return { kind: "summary" };
  const [name, ...rest] = args;
  if (name === "--help" || name === "-h") {
    if (rest.length) throw new Error("Run sparky-mcp help <command> for details.");
    return { kind: "help" };
  }
  const command = findCommand(name === "--version" ? "version" : name!);
  if (!command) throw new Error(unknownCommand(name!));
  const argument = command.positional && rest[0] && !rest[0].startsWith("-") ? rest.shift()! : "";
  const flags = parseFlags(command, rest);
  if (flags["--help"] || flags["-h"]) return { kind: "help", command: command.name };
  if (command.name === "help") {
    if (argument && !findCommand(argument)) throw new Error(unknownCommand(argument));
    return argument ? { kind: "help", command: argument } : { kind: "help" };
  }
  return { kind: "command", command, flags, argument };
}

export interface MainProbes {
  summary(): Promise<void>;
  print(text: string): void;
  execute(command: Command, flags: CommandFlags, argument: string): Promise<void>;
}

export async function main(args: string[], probes: MainProbes = {
  summary: async () => { await (await import("./cli/summary.js")).summary(); },
  print: console.log,
  execute: (command, flags, argument) => command.run(flags, argument),
}) {
  const result = route(args);
  if (result.kind === "summary") await probes.summary();
  else if (result.kind === "help") probes.print(renderHelp(result.command));
  else await probes.execute(result.command, result.flags, result.argument);
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Command failed.");
    process.exitCode = 1;
  }
}
