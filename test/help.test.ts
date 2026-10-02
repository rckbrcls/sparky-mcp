import { describe, expect, test } from "bun:test";
import { commands, findCommand } from "../src/cli/commands.js";
import { renderHelp, unknownCommand } from "../src/cli/help.js";
import { main, parseFlags, route } from "../src/main.js";

describe("command help", () => {
  test("registry and dispatch match every command and accepted flag", () => {
    const names = ["setup", "init", "start", "stop", "restart", "status", "logs", "pair", "info", "funnel", "connect", "doctor", "update", "serve", "version", "help"];
    expect(commands.map((command) => command.name).sort()).toEqual(names.sort());
    expect(new Set(commands.map((command) => command.name)).size).toBe(commands.length);
    for (const command of commands) {
      expect(typeof command.run).toBe("function");
      const routed = route([command.name]);
      if (command.name === "help") expect(routed.kind).toBe("help");
      else {
        expect(routed.kind).toBe("command");
        if (routed.kind === "command") expect(routed.command).toBe(command);
      }
      for (const flag of command.flags) {
        const value = flag.value ? ["example"] : [];
        expect(parseFlags(command, [flag.name, ...value])[flag.name]).toBe(flag.value ? "example" : true);
        expect(renderHelp(command.name)).toContain(flag.name);
      }
      expect(() => parseFlags(command, ["--undocumented"])).toThrow(`sparky-mcp help ${command.name}`);
    }
  });

  test("per-command pages show usage, flags, examples and security notes", () => {
    for (const command of commands) {
      const output = renderHelp(command.name);
      expect(output).toContain(command.summary);
      expect(output).toContain("Usage");
      expect(output).toContain("Flags");
      expect(output).toContain("Examples");
      for (const usage of command.usage) expect(output).toContain(usage);
      expect(command.examples.length).toBeGreaterThanOrEqual(2);
    }
    expect(renderHelp("info")).toContain("--reveal prints secrets");
    expect(renderHelp("funnel")).toContain("public internet");
  });

  test("overview groups commands and points to detailed help", () => {
    const output = renderHelp();
    for (const group of ["Get started", "Run", "Connect", "Maintain"]) expect(output).toContain(group);
    expect(output).toContain("Run sparky-mcp help <command> for details.");
  });

  test("suggestions are limited to two edits", () => {
    expect(unknownCommand("stat")).toContain('Unknown command: "stat". Did you mean "status"?');
    expect(unknownCommand("stats")).toContain('Did you mean "status"?');
    expect(unknownCommand("unrelated")).not.toContain("Did you mean");
    expect(() => route(["unrelated"])).toThrow("sparky-mcp --help");
  });

  test("command help aliases route to details without effects", async () => {
    for (const command of commands) {
      expect(route([command.name, "--help"])).toEqual({ kind: "help", command: command.name });
      expect(route([command.name, "-h"])).toEqual({ kind: "help", command: command.name });
      expect(route(["help", command.name])).toEqual({ kind: "help", command: command.name });
    }
    const printed: string[] = [];
    let executed = false;
    await main(["connect", "claude-code", "--help"], {
      async summary() { throw new Error("Unexpected summary"); },
      print: (text) => { printed.push(text); },
      async execute() { executed = true; },
    });
    expect(executed).toBe(false);
    expect(printed[0]).toContain("sparky-mcp connect <claude-code|codex|claude-web|chatgpt>");
  });

  test("no arguments call summary and version aliases dispatch normally", async () => {
    let called = false;
    await main([], { async summary() { called = true; }, print() {}, async execute() { throw new Error("Unexpected command"); } });
    expect(called).toBe(true);
    expect(route(["--help"])).toEqual({ kind: "help" });
    const result = route(["--version"]);
    expect(result.kind).toBe("command");
    if (result.kind === "command") expect(result.command).toBe(findCommand("version")!);
  });

  test("flag parsing reports duplicates and missing values with command help", () => {
    const command = findCommand("setup")!;
    expect(() => parseFlags(command, ["--yes", "--yes"])).toThrow("Duplicate flag: --yes");
    expect(() => parseFlags(command, ["--public-url"])).toThrow("Missing value for --public-url");
    expect(() => route(["status", "--invalid"])).toThrow("sparky-mcp help status");
  });
});
