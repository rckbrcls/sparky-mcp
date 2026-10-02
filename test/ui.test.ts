import { expect, test } from "bun:test";
import { box, checksText, color, displayWidth, fieldsText, header, symbol } from "../src/cli/ui.js";
import { doctorExitCode } from "../src/cli/doctor.js";

const tty = { tty: true, env: { LANG: "en_US.UTF-8", COLORTERM: "truecolor" } };

test("boxes wrap words and unbroken URLs within terminal limits", () => {
  for (const columns of [12, 30, 80, 140]) {
    const output = box("Public access", ["A very long line with many words to wrap around the terminal.", `https://host.test/${"a".repeat(140)}`], { ...tty, columns });
    const widths = output.split("\n").map(displayWidth);
    expect(Math.max(...widths)).toBeLessThanOrEqual(Math.min(columns - 2, 100));
    expect(new Set(widths).size).toBe(1);
  }
});

test("plain terminals omit escapes and use ASCII fallbacks", () => {
  for (const options of [{ tty: false, env: tty.env }, { tty: true, env: { ...tty.env, NO_COLOR: "" } }, { tty: true, env: { ...tty.env, TERM: "dumb" } }]) {
    const output = box("Title", ["Line"], options) + header("0.1.0", options) + fieldsText({ Service: "active" }, options);
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("╭");
    expect(symbol("✓", options)).toBe("ok");
  }
  expect(symbol("✗", { tty: true, env: { LANG: "C" } })).toBe("x");
});

test("TTY palette uses truecolor blue or bright blue with state colors", () => {
  expect(color("Sparky", "accent", tty)).toContain("38;2;0;107;255");
  expect(color("Sparky", "accent", { tty: true, env: {} })).toContain("94m");
  expect(fieldsText({ Service: "active", Health: "Unavailable", Warning: "warn" }, tty)).toContain("32mactive");
  expect(symbol("✓", tty)).toBe("✓");
});

test("doctor groups checks, prints hints and counts, preserving failure exit code", () => {
  const checks = [
    { label: "Config file", state: "PASS" as const, detail: "config.env exists." },
    { label: "Service active", state: "FAIL" as const, detail: "Run sparky-mcp start." },
    { label: "Funnel", state: "WARN" as const, detail: "Public access enabled." },
    { label: "Mirror freshness", state: "PASS" as const, detail: "Fresh." },
  ];
  const output = checksText(checks, false, { tty: false });
  for (const group of ["Config", "Service", "Network", "App"]) expect(output).toContain(group);
  expect(output).toContain("  Run sparky-mcp start.");
  expect(output).toContain("2 passed - 1 warnings - 1 failed");
  expect(doctorExitCode(checks)).toBe(1);
  expect(doctorExitCode(checks.filter((check) => check.state !== "FAIL"))).toBe(0);
  const compact = checksText(checks, true, { tty: false });
  expect(compact).not.toContain("Config file");
  expect(compact).toContain("Funnel");
});
