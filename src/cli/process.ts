export type RunResult = { code: number; stdout: string; stderr: string };

export async function run(args: string[], options: { input?: string; inherit?: boolean; timeout?: number } = {}): Promise<RunResult> {
  try {
    const child = Bun.spawn(args, {
      stdin: options.input === undefined ? (options.inherit ? "inherit" : "ignore") : new Blob([options.input]),
      stdout: options.inherit ? "inherit" : "pipe",
      stderr: options.inherit ? "inherit" : "pipe",
    });
    const timer = options.inherit ? undefined : setTimeout(() => child.kill(), options.timeout ?? 10000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        options.inherit ? "" : new Response(child.stdout).text(),
        options.inherit ? "" : new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    } finally { if (timer) clearTimeout(timer); }
  } catch { return { code: 127, stdout: "", stderr: `${args[0]} is unavailable.` }; }
}

export async function requireRun(args: string[], options: Parameters<typeof run>[1] = {}) {
  const result = await run(args, options);
  if (result.code !== 0) throw new Error(`${args[0]} failed (${result.code}). ${result.stderr.trim()}`);
  return result;
}
