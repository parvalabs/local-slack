# local-slack

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
client, so `apps.connections.open` hits the mock too. For Python's `slack_bolt`, set the client
`base_url` similarly.

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
| POST | `/command` | `{ channel, user, command, text }` |
| POST | `/interact` | `{ channel, messageTs, user, action }` |
| POST | `/reaction` | `{ channel, ts, user, name, present? }` (present defaults `true`) |
| POST | `/edit-message` | `{ channel, ts, user, text }` (only the message's own author may edit) |
| POST | `/delete-message` | `{ channel, ts, user }` (only the message's own author may delete) |
| POST | `/open-home` | `{ user }` |
| POST | `/reset` | — (restore config baseline) |
| GET | `/log` | ordered record of all bot-facing traffic |
| GET | `/state` | workspace / users / channels |
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

## Architecture

- **Runtime:** Bun. **HTTP:** Hono (runtime-agnostic). **WebSockets:** `Bun.serve` native.
- `server/` — config loader (zod/yaml), in-memory store + event bus, Web API methods, Socket Mode
  server, Events API dispatcher (signs deliveries), interactions (trigger_id / response_url / views),
  UI gateway, control + hooks routers.
- `web/` — React + Vite UI (sidebar, message list, composer, Block Kit renderer, modals, App Home,
  Inspector).
- `examples/echo-bot/` — a real Bolt app used for end-to-end verification.

Not a security boundary: tokens/signatures are validated only enough for realism. Local testing only.
