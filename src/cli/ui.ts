export type Check = { label: string; state: "PASS" | "WARN" | "FAIL"; detail: string; section?: string; hint?: string };
export interface UIOptions { tty?: boolean; columns?: number; env?: NodeJS.ProcessEnv }

function terminal(options: UIOptions = {}) {
  const env = options.env || process.env;
  const tty = options.tty ?? Boolean(process.stdout.isTTY);
  const plain = !tty || env.NO_COLOR !== undefined || env.TERM === "dumb";
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return { color: !plain, unicode: !plain && /utf-?8/i.test(locale), columns: options.columns || process.stdout.columns || 80, env };
}

export function color(text: string, code: number | "accent", options: UIOptions = {}): string {
  const t = terminal(options);
  const value = code === "accent" ? /^(truecolor|24bit)$/i.test(t.env.COLORTERM || "") ? "38;2;0;107;255" : "94" : code === 2 ? "2" : code;
  return t.color ? `\x1b[${value}m${text}\x1b[0m` : text;
}

const COMMAND_NAMES = "setup|init|start|stop|restart|status|logs|pair|connect|funnel|info|doctor|update|serve|help|version";
const COMMAND_PATTERN = new RegExp(`\\bsparky-mcp(?: (?:${COMMAND_NAMES}))?(?: (?:--?[a-z][a-z-]*|<[a-z-]+>|on|off|claude-code|codex|claude-web|chatgpt))*(?![\\w-])`, "g");

/** Marks command snippets such as `sparky-mcp help` with bold accent so they stand out from prose. Plain terminals are left untouched. */
export function highlight(text: string, options: UIOptions = {}): string {
  const t = terminal(options);
  return t.color ? text.replace(COMMAND_PATTERN, (match) => `\x1b[1m${color(match, "accent", options)}`) : text;
}

export function symbol(value: "✓" | "!" | "✗" | "›" | "•", options: UIOptions = {}): string {
  return terminal(options).unicode ? value : { "✓": "ok", "!": "!", "✗": "x", "›": ">", "•": "-" }[value];
}

export function displayWidth(text: string): number { return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length; }

export function stateValue(value: string, options: UIOptions = {}): string {
  const code = /^(active|ok|on|pass)$/i.test(value) ? 32 : /^(inactive|unavailable|off|fail|unsupported)$/i.test(value) ? 31 : /warn|unknown|never/i.test(value) ? 33 : 0;
  return code ? color(value, code, options) : value;
}

export function fieldsText(fields: Record<string, string>, options: UIOptions = {}): string {
  const width = Math.max(0, ...Object.keys(fields).map(displayWidth));
  return Object.entries(fields).map(([label, value]) => `${color(label.padEnd(width), 2, options)}  ${stateValue(terminal(options).unicode ? value : value.replace(/•/g, "*"), options)}`).join("\n");
}

export function printFields(fields: Record<string, string>) { console.log(fieldsText(fields)); }
export function header(version: string, options: UIOptions = {}): string { return color(`${terminal(options).unicode ? "▍" : "|"}Sparky MCP  v${version}`, "accent", options); }
export function step(n: number, total: number, title: string) { console.log(`\n${color(`${n}/${total}`, "accent")} ${title}`); }
export function hint(text: string) { console.log(`  ${highlight(text)}`); }

function section(check: Check): string {
  if (check.section) return check.section;
  if (/^(Config|Required|Public URL|Port)/.test(check.label)) return "Config";
  if (/^(Service|User linger|Local health)/.test(check.label)) return "Service";
  if (/^(Database|Mirror)/.test(check.label)) return "App";
  return "Network";
}

export function checksText(checks: Check[], compact = false, options: UIOptions = {}): string {
  const lines: string[] = [];
  for (const group of ["Config", "Service", "Network", "App"]) {
    const members = checks.filter((check) => section(check) === group && (!compact || check.state !== "PASS"));
    if (!members.length) continue;
    if (lines.length) lines.push("");
    lines.push(color(group, "accent", options));
    for (const check of members) {
      const mark = color(symbol({ PASS: "✓", WARN: "!", FAIL: "✗" }[check.state] as "✓" | "!" | "✗", options), { PASS: 32, WARN: 33, FAIL: 31 }[check.state], options);
      const detail = check.state === "PASS" || check.hint ? check.detail : { WARN: "Needs attention.", FAIL: "Check failed." }[check.state];
      lines.push(`${mark} ${check.label}  ${highlight(detail, options)}`);
      if (check.state !== "PASS") lines.push(`  ${highlight(check.hint || check.detail, options)}`);
    }
  }
  const count = (state: Check["state"]) => checks.filter((check) => check.state === state).length;
  const dot = terminal(options).unicode ? "·" : "-";
  lines.push("", `${count("PASS")} passed ${dot} ${count("WARN")} warnings ${dot} ${count("FAIL")} failed`);
  return lines.join("\n");
}

export function printChecks(checks: Check[], compact = false) { console.log(checksText(checks, compact)); }

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    let line = "";
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && displayWidth(`${line} ${word}`) > width) { lines.push(line); line = ""; }
      while (displayWidth(word) > width) {
        if (line) { lines.push(line); line = ""; }
        const chars = [...word];
        lines.push(chars.slice(0, width).join(""));
        word = chars.slice(width).join("");
      }
      if (word) line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

export function box(title: string, lines: string[], options: UIOptions = {}): string {
  const t = terminal(options);
  const limit = Math.max(6, Math.min(t.columns - 2, 100));
  const width = Math.min(limit - 4, Math.max(displayWidth(title) + 2, ...lines.map(displayWidth), 1));
  const heading = [...title].slice(0, width - 2).join("");
  const top = t.unicode ? `╭─ ${heading} ${"─".repeat(width - displayWidth(heading) - 1)}╮` : `+- ${heading} ${"-".repeat(width - displayWidth(heading) - 1)}+`;
  const edge = t.unicode ? "│" : "|";
  return [top, ...lines.flatMap((line) => wrap(line, width)).map((line) => `${edge} ${line}${" ".repeat(width - displayWidth(line))} ${edge}`), `${t.unicode ? "╰" : "+"}${(t.unicode ? "─" : "-").repeat(width + 2)}${t.unicode ? "╯" : "+"}`].join("\n");
}

export function spinner(text: string) {
  if (!terminal().color) { console.log(`${text}...`); return { stop() {} }; }
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  let stopped = false;
  process.stdout.write("\x1b[?25l");
  const render = () => process.stdout.write(`\r\x1b[2K${color(frames[frame++ % frames.length]!, "accent")} ${text}`);
  render();
  const timer = setInterval(render, 100);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stdout.write("\r\x1b[2K\x1b[?25h");
    process.off("SIGINT", interrupt);
    process.off("exit", stop);
  };
  const handled = process.listenerCount("SIGINT") > 0;
  const interrupt = () => {
    stop();
    if (!handled) process.exit(130);
  };
  process.once("SIGINT", interrupt);
  process.once("exit", stop);
  return { stop };
}
