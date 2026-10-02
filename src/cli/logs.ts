import { existsSync } from "node:fs";
import { paths } from "./paths.js";
import { requireRun } from "./process.js";

export async function logs(follow = false) {
  if (process.platform === "linux") await requireRun(["journalctl", "--user", "-u", "sparky-mcp", ...(follow ? ["-f"] : ["-n", "100", "--no-pager"])], { inherit: true });
  else if (process.platform === "darwin") {
    if (!existsSync(paths().log)) throw new Error("No log file yet. Run `sparky-mcp start` first.");
    await requireRun(["tail", "-n", "100", ...(follow ? ["-f"] : []), paths().log], { inherit: true });
  } else throw new Error("Logs are supported on Linux and macOS only.");
}
