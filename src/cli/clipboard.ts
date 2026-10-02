import { run } from "./process.js";

export async function copy(value: string) {
  const commands = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
  for (const args of commands) if ((await run(args, { input: value })).code === 0) return;
  throw new Error("Clipboard unavailable. Install wl-copy, xclip, or xsel on Linux.");
}
