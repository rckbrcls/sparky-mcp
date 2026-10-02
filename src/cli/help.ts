import { commands, findCommand, type CommandGroup } from "./commands.js";
import { color, highlight } from "./ui.js";

export function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[right.length]!;
}

export function unknownCommand(name: string): string {
  const candidates = commands.map((command) => ({ name: command.name, distance: distance(name, command.name) })).sort((left, right) => Number(right.name.startsWith(name)) - Number(left.name.startsWith(name)) || left.distance - right.distance);
  const candidate = candidates[0];
  const suggestion = candidate && candidate.distance <= 2 ? ` Did you mean "${candidate.name}"?` : "";
  return `Unknown command: "${name}".${suggestion}\n${highlight("Run sparky-mcp --help for commands.")}`;
}

export function renderHelp(name?: string): string {
  if (!name) {
    const width = Math.max(...commands.map((command) => command.name.length));
    const lines = ["Usage: sparky-mcp <command> [flags]", ""];
    const groups: CommandGroup[] = ["Get started", "Run", "Connect", "Maintain"];
    for (const group of groups) {
      lines.push(color(group, "accent"));
      for (const command of commands.filter((command) => command.group === group && command.name !== "help")) lines.push(`  ${color(command.name.padEnd(width), "accent")}  ${command.summary}`);
      lines.push("");
    }
    lines.push(highlight("Run sparky-mcp help <command> for details."));
    return lines.join("\n");
  }
  const command = findCommand(name);
  if (!command) throw new Error(unknownCommand(name));
  const lines = [color(`sparky-mcp ${command.name}`, "accent"), command.summary, "", color("Usage", "accent"), ...command.usage.map((usage) => `  ${highlight(usage)}`), "", color("Flags", "accent")];
  const labels = command.flags.map((flag) => `${flag.name}${flag.value ? ` ${flag.value}` : ""}`);
  const width = Math.max(...labels.map((label) => label.length));
  for (let i = 0; i < command.flags.length; i++) lines.push(`  ${color(labels[i]!.padEnd(width), 2)}  ${command.flags[i]!.description}`);
  lines.push("", color("Examples", "accent"), ...command.examples.map((example) => `  ${highlight(example)}`));
  if (command.notes?.length) lines.push("", color("Notes", "accent"), ...command.notes.map((note) => `  ${note}`));
  return lines.join("\n");
}
