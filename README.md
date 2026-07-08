# local-slack

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A **local, throwaway Slack** for developing and testing Slack apps/bots — not a Slack
replacement. Your bot connects to it exactly as it would to real Slack (Web API + Socket Mode +
Events API), and a Slack-like **web UI** lets a human "act as" a workspace user and watch the
users ↔ bot interaction in real time. Workspace, users and channels are defined declaratively in a
config file.

It's the inverse of test-interception libraries like `slack-testing-library` / `slack-mock`: a real
running server with a browser UI, plus a programmatic control API so it can also drive automated
tests.

## What it supports

- **Web API** — `auth.test`, `chat.*`, `conversations.*`, `users.*`, `views.*`, `reactions.*`, `apps.connections.open`, `team.info`, `bots.info`
- **Two delivery modes** (per-app config switch):
  - **Socket Mode** — the bot opens a WebSocket (via `apps.connections.open` → `ws://…`)
  - **Events API (HTTP)** — signed POSTs to the bot's request URL (real `x-slack-signature`, so Bolt's verification passes)
- **Interactivity** — Block Kit rendering, buttons → `block_actions`, modals via `views.open/update/push` + `view_submission` (with `response_action` errors/update/push/clear)
- **Slash commands** and the **App Home** tab
- **Threads** — a docked thread pane (reply summaries on the parent message, `conversations.replies`, `reply_count`/`latest_reply` on the parent via `conversations.history`)
- **Human-driven reactions, edit, and delete** — react from the UI (delivers `reaction_added`/`reaction_removed`), and edit/delete your own messages (delivers `message_changed`/`message_deleted`); bot messages can't be edited/deleted this way
- **Multiple apps in one workspace** — declare several apps under `apps:`; each gets its own tokens, delivery mode, Socket Mode connection(s) and Home tab. Channel events fan out to every app that's a member; interactive components (buttons/modals) and slash commands route to the specific app that owns them
- **Inspector** — a live view of raw traffic to/from the bot (envelopes, HTTP, acks, Web API calls)

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`)
- Node is only needed to run the example Bolt bot (Bolt targets Node).

## Quick start

```bash
bun install
bun run dev        # backend on :3000, Vite UI on :5173 (proxies to the backend)
```

Open the UI at **http://localhost:5173** (dev) — or run the server standalone and open
**http://localhost:3000**:

```bash
bun run start      # serves the built UI + API on one port (:3000)
```

Then start the example bot against it (in another terminal):

```bash
cd examples/echo-bot && npm install
SLACK_MODE=socket SLACK_API_URL=http://localhost:3000/api/ node index.js
```

Post a message in the UI as a user → the bot receives it and replies. Type `button` to get
interactive buttons and a modal; type `/echo hi` for a slash command; open **Apps → testbot** for
the App Home tab.

A Python (`slack_bolt`) version of the same bot lives in
[`examples/echo-bot-py`](examples/echo-bot-py) — the mock isn't Bolt-JS-specific:

```bash
cd examples/echo-bot-py && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SLACK_API_URL=http://localhost:3000/api/ python index.py
```

## Point your own Bolt app at it

No code changes — just configuration:

```js
// Socket Mode
new App({
  token: "xoxb-test-token",        // must match config.app.botToken
  appToken: "xapp-test-token",     // must match config.app.appToken
  socketMode: true,
  clientOptions: { slackApiUrl: "http://localhost:3000/api/" },
});

// Events API (HTTP)
new App({
  token: "xoxb-test-token",
  signingSecret: "test-signing-secret", // must match config.app.signingSecret
  clientOptions: { slackApiUrl: "http://localhost:3000/api/" },
}).start(4000); // config.app.requestUrl must point here, e.g. http://localhost:4000/slack/events
```

`clientOptions.slackApiUrl` is passed through to both the main WebClient and the Socket Mode
client, so `apps.connections.open` hits the mock too.

For Python's `slack_bolt`, pass a `WebClient` with `base_url` set — both to the `App` and, for
Socket Mode, explicitly to `SocketModeHandler` (its client defaults to `app.client`, which is
authenticated with the *bot* token, not the *app-level* token Socket Mode needs):

```python
from slack_sdk import WebClient
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

API_URL = "http://localhost:3000/api/"
app = App(client=WebClient(token="xoxb-test-token", base_url=API_URL))
handler = SocketModeHandler(app, "xapp-test-token", web_client=WebClient(token="xapp-test-token", base_url=API_URL))
handler.start()
```

See [`examples/echo-bot-py`](examples/echo-bot-py) for a complete, verified example.

## Configuration

See [`examples/config.yaml`](examples/config.yaml). Run with `--config <path>`.

```yaml
workspace: { name: Test Workspace, domain: test-workspace, teamId: T01TEST }
app:
  appId: A01APP
  botUserId: U0BOT
  botName: testbot
  botToken: xoxb-test-token
  appToken: xapp-test-token
  signingSecret: test-signing-secret
  mode: socket                     # "socket" | "events"
  requestUrl: http://localhost:4000/slack/events   # used when mode: events
users:
  - { id: U01ALICE, name: alice, real_name: Alice Anderson }
channels:
  - { id: C01GEN, name: general, members: [U01ALICE, U0BOT] }
```

### Multiple apps

Replace the singular `app:` with an `apps:` list to run more than one app against the same
workspace at once — e.g. testing bot-to-bot interaction, or exercising two separate apps together.
Every app needs a unique `appId`, `botUserId` and `botToken`. See
[`examples/config.multiapp.yaml`](examples/config.multiapp.yaml) (paired with
[`examples/echo-bot`](examples/echo-bot) and [`examples/shout-bot`](examples/shout-bot)).

```yaml
apps:
  - appId: A01APP
    botUserId: U0BOT
    botName: echobot
    botToken: xoxb-echobot-token
    appToken: xapp-echobot-token
    mode: socket
  - appId: A02APP
    botUserId: U0BOT2
    botName: shoutbot
    botToken: xoxb-shoutbot-token
    appToken: xapp-shoutbot-token
    mode: socket
channels:
  - { id: C01GEN, name: general, members: [U01ALICE, U0BOT, U0BOT2] }
```

Routing rules (matching real Slack as closely as this mock reasonably can):
- **Channel events** (messages, reactions, edits, deletes) fan out to every app whose bot is a
  member of the channel.
- **Interactive components** (buttons, modals) route to whichever app posted the message or opened
  the view — inferred automatically, no configuration needed.
- **Slash commands** and **opening a Home tab** target one specific app, since this mock doesn't
  model per-command registration. The UI's "As app" selector (shown once ≥2 apps are configured)
  picks the target for slash commands typed in the composer; `/_control/command` and
  `/_control/open-home` accept an optional `appId` in the body (defaults to the first configured
  app).

## Tests

```bash
bun run test        # unit tests (config/signing/store/interactions/Web API) + integration
                     # tests that spin up the real server and drive it over HTTP/WebSocket
```

## CLI

```
local-slack --config <path> [--port <n>] [--open]
```

| Flag | Description | Default |
| --- | --- | --- |
| `--config` | Path to the workspace config (YAML/JSON) | `config.yaml` |
| `--port` | Port for the UI + API + WebSockets | `3000` |
| `--open` | Open the web UI in the browser on start | — |

## Control API (for automated tests)

Drive the workspace and inspect bot traffic without the UI (base `http://localhost:3000/_control`):

| Method | Endpoint | Body |
| --- | --- | --- |
| POST | `/message` | `{ channel, user, text, thread_ts? }` |
| POST | `/command` | `{ channel, user, command, text, appId? }` (appId defaults to the first configured app) |
| POST | `/interact` | `{ channel, messageTs, user, action }` (routes to the message's own app automatically) |
| POST | `/reaction` | `{ channel, ts, user, name, present? }` (present defaults `true`) |
| POST | `/edit-message` | `{ channel, ts, user, text }` (only the message's own author may edit) |
| POST | `/delete-message` | `{ channel, ts, user }` (only the message's own author may delete) |
| POST | `/open-home` | `{ user, appId? }` (appId defaults to the first configured app) |
| POST | `/reset` | — (restore config baseline) |
| GET | `/log` | ordered record of all bot-facing traffic |
| GET | `/state` | workspace / apps / users / channels |
| GET | `/messages/:channel` | messages in a channel |

```bash
curl -X POST localhost:3000/_control/message \
  -H 'content-type: application/json' \
  -d '{"channel":"C01GEN","user":"U01ALICE","text":"hello"}'
curl localhost:3000/_control/log   # assert on what the bot received / sent
```

## Single-file binary

```bash
bun run build:binary   # builds the UI, inlines it, and compiles a standalone executable
./local-slack --config examples/config.yaml
```

Produces `./local-slack` — a standalone binary (no Bun/Node needed on the target) with the web UI
embedded.

### Cross-platform builds

```bash
bun run build:binaries   # builds for every platform below into dist-bin/
```

Cross-compiles via Bun's `--target` (see [`server/scripts/build-binaries.ts`](server/scripts/build-binaries.ts)),
downloading each target toolchain on first use:

| Binary | Platform |
| --- | --- |
| `local-slack-darwin-arm64` | macOS, Apple Silicon |
| `local-slack-darwin-x64` | macOS, Intel |
| `local-slack-linux-x64` | Linux, x64 |
| `local-slack-linux-arm64` | Linux, ARM64 |
| `local-slack-windows-x64.exe` | Windows, x64 |

To build just one, pass its target to the script directly: `bun scripts/build-binaries.ts bun-darwin-arm64`
(run from `server/`).

## Publishing / running via bunx or npx

The publishable package lives in [`server/`](server) and is named `local-slack` — that's the
package `bunx local-slack` / `npx local-slack` would install and run, independent of this
monorepo's root package (`local-slack-workspace`, private, never published).

It's self-contained: `server/package.json`'s `prepublishOnly` builds the web UI and stages a copy
into `server/public/` (via [`server/scripts/copy-ui.ts`](server/scripts/copy-ui.ts)), which is
included in the published files alongside `src/`. `npm publish` from `server/` (after `npm login`)
runs that automatically. To sanity-check the packed contents without actually publishing:

```bash
cd server && bun pm pack   # writes local-slack-<version>.tgz; inspect/extract it to confirm
                            # public/index.html and src/ are both present, no web/ dependency
```

Note `npx`/`bunx` both just exec the `bin` entry, whose shebang is `#!/usr/bin/env bun` — Bun must
be installed wherever it runs, same as everywhere else in this project.

## Architecture

- **Runtime:** Bun. **HTTP:** Hono (runtime-agnostic). **WebSockets:** `Bun.serve` native.
- `server/` — config loader (zod/yaml), in-memory store + event bus, Web API methods, Socket Mode
  server, Events API dispatcher (signs deliveries), interactions (trigger_id / response_url / views),
  UI gateway, control + hooks routers.
- `web/` — React + Vite UI (sidebar, message list, composer, Block Kit renderer, modals, App Home,
  Inspector).
- `examples/echo-bot/` — a real Bolt (JS) app used for end-to-end verification.
- `examples/echo-bot-py/` — the same bot in Bolt for Python, proving the mock is SDK-agnostic.
- `examples/shout-bot/` — a second Bolt app, paired with `examples/config.multiapp.yaml` to verify multi-app support.

Not a security boundary: tokens/signatures are validated only enough for realism. Local testing only.
