import { expect, test } from "bun:test";
import { connectorUrl, connectTarget, type ConnectProbes } from "../src/cli/connect.js";

function fake(overrides: Partial<ConnectProbes> = {}): ConnectProbes {
  return {
    config: () => ({ exists: true, values: { PUBLIC_URL: "https://host.test", API_TOKEN: "private-token", ADMIN_PASSWORD: "private-password" } }),
    installed: () => true, run: async () => ({ code: 0, stdout: "", stderr: "" }),
    secret: async () => "prompt-token", stdin: async () => "stdin-token\n", copy: async () => {},
    confirm: async () => true, wait: async () => "", funnel: async () => ({ active: true }), tty: false, message: () => {}, ...overrides,
  };
}

test("normalizes URL and rejects HTTP and credentials", () => {
  expect(connectorUrl("https://host.test/")).toBe("https://host.test/mcp");
  expect(connectorUrl("https://host.test/custom")).toBe("https://host.test/custom");
  for (const url of ["http://host.test", "https://user:secret@host.test"]) expect(() => connectorUrl(url)).toThrow();
});

test("token sources and remove then add order", async () => {
  for (const [options, token] of [[{}, "private-token"], [{ url: "https://remote.test" }, "prompt-token"], [{ tokenStdin: true }, "stdin-token"]] as const) {
    const calls: string[][] = [];
    const messages: string[] = [];
    const result = await connectTarget("claude-code", options, fake({ run: async (args) => { calls.push(args); return { code: 0, stdout: token, stderr: token }; }, message: (text) => { messages.push(text); } }));
    expect(calls[0]).toEqual(["claude", "mcp", "remove", "sparky", "--scope", "user"]);
    expect(calls[1]?.slice(0, 8)).toEqual(["claude", "mcp", "add", "--scope", "user", "--transport", "http", "sparky"]);
    expect(calls[1]?.at(-1)).toBe(`Authorization: Bearer ${token}`);
    expect(JSON.stringify(result) + messages.join("")).not.toContain(token);
  }
});

test("explicit URL without config prompts; add failure never surfaces client secrets", async () => {
  await expect(connectTarget("claude-code", { url: "https://remote.test" }, fake({
    config: () => ({ exists: false, values: {} }),
    run: async () => ({ code: 1, stdout: "prompt-token", stderr: "prompt-token" }),
  }))).rejects.toThrow("claude mcp add failed (1)");
});

test("codex uses runtime environment variable and privately copies shell export", async () => {
  const calls: string[][] = [];
  const copied: string[] = [];
  const messages: string[] = [];
  await connectTarget("codex", {}, fake({
    tty: true, copy: async (value) => { copied.push(value); }, message: (text) => { messages.push(text); },
    run: async (args) => { calls.push(args); return { code: args[2] === "remove" ? 1 : 0, stdout: "", stderr: "" }; },
    confirm: async (_, options) => { expect(options?.defaultYes).toBe(true); return true; },
  }));
  expect(calls).toEqual([["codex", "mcp", "remove", "sparky"], ["codex", "mcp", "add", "sparky", "--url", "https://host.test/mcp", "--bearer-token-env-var", "SPARKY_MCP_TOKEN"]]);
  expect(copied).toEqual(["export SPARKY_MCP_TOKEN='private-token'"]);
  expect(messages.join("")).not.toContain("private-token");
});

test("missing binaries and unknown targets fail clearly", async () => {
  for (const target of ["claude-code", "codex"]) await expect(connectTarget(target, {}, fake({ installed: () => false }))).rejects.toThrow("unavailable");
  await expect(connectTarget("unknown", {}, fake())).rejects.toThrow("claude-code, codex, claude-web, chatgpt");
});

test("guided flows copy URL then password then clear, and warn about Funnel", async () => {
  for (const target of ["claude-web", "chatgpt"]) {
    const events: string[] = [];
    const messages: string[] = [];
    await connectTarget(target, {}, fake({
      tty: true, funnel: async () => ({ active: false }),
      copy: async (value) => { events.push(value); }, wait: async () => { events.push("wait"); return ""; },
      message: (text) => { messages.push(text); },
    }));
    expect(events).toEqual(["https://host.test/mcp", "wait", "private-password", "wait", ""]);
    expect(messages.join("")).toContain("sparky-mcp funnel on");
    expect(messages.join("")).not.toContain("private-password");
    await expect(connectTarget(target, {}, fake())).rejects.toThrow("on the server");
  }
});

test("guided flow clears clipboard when interrupted", async () => {
  const copied: string[] = [];
  await expect(connectTarget("claude-web", {}, fake({ tty: true, copy: async (text) => { copied.push(text); }, wait: async () => { throw new Error("Cancelled"); } }))).rejects.toThrow("Cancelled");
  expect(copied).toEqual(["https://host.test/mcp", ""]);
});

test("CLI rejects --token without printing its value", async () => {
  const child = Bun.spawn([process.execPath, "src/main.ts", "connect", "codex", "--token", "history-secret"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(output).toContain("Unknown flag: --token");
  expect(output).not.toContain("history-secret");
});

test("codex skips clipboard prompt without a TTY", async () => {
  await connectTarget("codex", {}, fake({
    confirm: async () => { throw new Error("Must not prompt"); },
    copy: async () => { throw new Error("Must not copy"); },
  }));
});

test("guided flow requires local config even with an explicit URL", async () => {
  await expect(connectTarget("chatgpt", { url: "https://remote.test" }, fake({ tty: true, config: () => ({ exists: false, values: {} }) }))).rejects.toThrow("on the server");
});
