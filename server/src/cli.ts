#!/usr/bin/env bun
import { loadConfig } from "./config/load.ts";
import { startServer } from "./server.ts";

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
  local-slack --config <path> [--port <n>] [--open]

Options:
  --config <path>   Path to the workspace config (YAML or JSON). Default: config.yaml
  --port <n>        Port for the UI + API + WebSockets. Default: 3000
  --open            Open the web UI in your browser on start
  --help            Show this help
`;

const args = parseArgs(Bun.argv.slice(2));

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const configPath = typeof args.config === "string" ? args.config : "config.yaml";
const port = Number(args.port ?? 3000);

let config;
try {
  config = await loadConfig(configPath);
} catch (e) {
  console.error(`\n  ✗ ${(e as Error).message}\n`);
  process.exit(1);
}

const { server } = await startServer({ config, port });
const base = `http://localhost:${server.port}`;

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
