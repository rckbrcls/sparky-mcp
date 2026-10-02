import { createInterface } from "node:readline/promises";

export async function line(question: string, signal?: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") throw new Error("A terminal is required.");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  if (signal) input.on("SIGINT", () => { process.emit("SIGINT"); });
  try { return (await input.question(question, { signal })).trim(); } finally { input.close(); }
}

export async function confirm(question: string, options: { yes?: boolean; defaultYes?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") throw new Error("Pass --yes to confirm.");
  const answer = await line(`${question} ${options.defaultYes ? "[Y/n]" : "[y/N]"} `, options.signal);
  return /^y(?:es)?$/i.test(answer) || (!answer && Boolean(options.defaultYes));
}

export async function secret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") throw new Error("Use --token-stdin or run in a terminal to enter the token.");
  const input = process.stdin;
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  process.stdout.write(question);
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const cleanup = () => { input.off("data", data); input.off("end", end); input.off("error", error); };
      const end = () => { cleanup(); reject(new Error("Token input closed.")); };
      const error = () => { cleanup(); reject(new Error("Token input failed.")); };
      const data = (chunk: Buffer) => {
        for (const ch of chunk.toString()) {
          if (ch === "\r" || ch === "\n") { cleanup(); resolve(value); return; }
          if (ch === "\x03" || ch === "\x04") { cleanup(); reject(new Error("Cancelled.")); return; }
          if (ch === "\x7f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " " && ch !== "\x1b") value += ch;
        }
      };
      input.on("data", data);
      input.once("end", end);
      input.once("error", error);
    });
  } finally {
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
    process.stdout.write("\n");
  }
}
