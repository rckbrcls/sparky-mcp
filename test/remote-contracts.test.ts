import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("remote contracts run in a fresh process with an isolated database", async () => {
  const root = mkdtempSync(join(tmpdir(), "sparky-contracts-"));
  try {
    const child = Bun.spawn([process.execPath, "test", "./test/fixtures/remote-contracts.cases.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SPARKY_MCP_HOME: root, DATA_DIR: root,
        PUBLIC_URL: "https://sparky-test.invalid", API_TOKEN: "synthetic-test-token",
        ADMIN_PASSWORD: "synthetic-test-password", USER_TIMEZONE: "America/Sao_Paulo" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    console.log(stdout + stderr);
    expect(code).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
