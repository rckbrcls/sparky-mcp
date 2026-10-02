export type Check = { label: string; state: "PASS" | "WARN" | "FAIL"; detail: string };

export function color(text: string, code: number): string {
  return process.stdout.isTTY && process.env.NO_COLOR === undefined ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function printFields(fields: Record<string, string>) {
  const width = Math.max(...Object.keys(fields).map((key) => key.length));
  for (const [label, value] of Object.entries(fields)) console.log(`${label.padEnd(width)}  ${value}`);
}

export function printChecks(checks: Check[]) {
  const width = Math.max(...checks.map((check) => check.label.length));
  for (const check of checks) {
    const symbol = { PASS: "✓", WARN: "!", FAIL: "✗" }[check.state];
    console.log(`${color(`${symbol} ${check.state}`, { PASS: 32, WARN: 33, FAIL: 31 }[check.state])}  ${check.label.padEnd(width)}  ${check.detail}`);
  }
}

export function box(title: string, lines: string[]): string {
  const width = Math.max(title.length, ...lines.map((text) => text.length));
  const border = `+${"-".repeat(width + 2)}+`;
  return [border, `| ${color(title.padEnd(width), 33)} |`, ...lines.map((text) => `| ${text.padEnd(width)} |`), border].join("\n");
}
