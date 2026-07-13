#!/usr/bin/env bun
import { loadConfig } from "./config/load.ts";
import { startServer } from "./server.ts";
import { VERSION } from "./version.ts";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const HELP = `local-slack — a local Slack mock for testing bots/apps

Usage:
  local-slack --config <path> [--port <n>] [--base-host <host>] [--open]

Options:
  --config <path>      Path to the workspace config (YAML or JSON). Default: config.yaml
  --port <n>           Port for the UI + API + WebSockets. Default: 3000
  --base-host <host>   Hostname clients use to reach this server, e.g. for the
                        Socket Mode ws:// URL and interactive response_url
                        callbacks. Override this when the bot runs elsewhere
                        (a different pod/container) and can't resolve
                        "localhost" back to this server. Default: localhost
  --open               Open the web UI in your browser on start
  -v, --version        Show the version number
  -h, --help           Show this help
`;

const argv = Bun.argv.slice(2);

if (argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
if (argv.includes("-v") || argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const args = parseArgs(argv);

const configPath = typeof args.config === "string" ? args.config : "config.yaml";
const port = Number(args.port ?? 3000);
const baseHost = typeof args["base-host"] === "string" ? args["base-host"] : "localhost";

let config;
try {
  config = await loadConfig(configPath);
} catch (e) {
  console.error(`\n  ✗ ${(e as Error).message}\n`);
  process.exit(1);
}

const { server } = await startServer({ config, port, baseHost });
const base = `http://${baseHost}:${server.port}`;

const appLines = config.apps
  .map((a, i) => {
    const last = i === config.apps.length - 1;
    const branch = last ? "└─" : "├─";
    const detail = a.mode === "events" ? ` (requestUrl: ${a.requestUrl})` : "";
    return `  ${branch} ${a.appId}: ${a.mode} mode${detail}`;
  })
  .join("\n");

console.log(`
  local-slack is running
  ├─ Web UI:        ${base}
  ├─ Web API base:  ${base}/api/   ← set each bot's slackApiUrl to this
  ├─ Control API:   ${base}/_control
  └─ Apps:
${appLines}
`);

if (args.open) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([opener, base]);
  } catch {
    /* ignore */
  }
}
