import { expect, test } from "bun:test";
import { getSummary, nextStep, relativeTime, summaryText, type SummaryProbes } from "../src/cli/summary.js";

const now = Date.parse("2026-10-02T12:00:00Z");
const ready = { initialized: true, service: "active", funnel: true, syncedAt: new Date(now).toISOString(), now };

test("next step follows all rules in priority order", () => {
  expect(nextStep({ ...ready, initialized: false, service: "inactive", funnel: false, syncedAt: null })).toBe("sparky-mcp setup");
  expect(nextStep({ ...ready, service: "inactive", funnel: false, syncedAt: null })).toBe("sparky-mcp start");
  expect(nextStep({ ...ready, funnel: false, syncedAt: null })).toBe("sparky-mcp funnel on");
  expect(nextStep({ ...ready, syncedAt: null })).toBe("sparky-mcp pair");
  expect(nextStep({ ...ready, syncedAt: "bad" })).toBe("sparky-mcp pair");
  expect(nextStep({ ...ready, syncedAt: new Date(now - 86400001).toISOString() })).toBe("Open Sparky and tap Sync now");
  expect(nextStep({ ...ready, funnel: null })).toContain("All good.");
});

test("relative times handle never, seconds, minutes, hours, days, and future dates", () => {
  expect(relativeTime(null, now)).toBe("Never");
  expect(relativeTime("bad", now)).toBe("Never");
  for (const [offset, expected] of [[0, "Just now"], [-1000, "Just now"], [60000, "1 minute ago"], [120000, "2 minutes ago"], [3600000, "1 hour ago"], [172800000, "2 days ago"]] as const) {
    expect(relativeTime(new Date(now - offset).toISOString(), now)).toBe(expected);
  }
});

test("uninitialized summary skips external probes and prints setup instruction", async () => {
  const unused = () => { throw new Error("Must not probe"); };
  const probes: SummaryProbes = {
    config: () => ({ exists: false, values: {}, port: "8787", data: "/unused" }),
    service: unused, health: unused, funnel: unused, database: unused, now: () => now,
  };
  const output = summaryText(await getSummary(probes), { tty: false });
  expect(output).toContain("Sparky MCP isn't set up yet.");
  expect(output).toContain("Next step: sparky-mcp setup");
});

test("summary probes concurrently, tolerates failures, and excludes secrets", async () => {
  let started = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const probe = async () => { if (++started === 3) release(); await pending; };
  const result = await getSummary({
    config: () => ({ exists: true, values: { PUBLIC_URL: "https://host.test", API_TOKEN: "private-token" }, port: "8787", data: "/unused" }),
    service: async () => { await probe(); return "active"; },
    health: async () => { await probe(); return true; },
    funnel: async () => { await probe(); throw new Error("unavailable"); },
    database: () => ({ syncedAt: null }), now: () => now,
  });
  const output = summaryText(result, { tty: false });
  expect(output).toContain("Unknown");
  expect(output).toContain("https://host.test/mcp");
  expect(output).not.toContain("private-token");
});
