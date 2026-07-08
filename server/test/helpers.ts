import { ConfigSchema, type Config, type AppConfig } from "../src/config/schema.ts";
import { Store } from "../src/state/store.ts";
import { SocketManager } from "../src/socket/manager.ts";
import { Interactions } from "../src/interactions.ts";
import type { BotGateway } from "../src/gateway/bot.ts";
import type { MethodContext } from "../src/web-api/methods.ts";

const DEFAULT_APP: Partial<AppConfig> = {
  appId: "A01APP",
  botUserId: "U0BOT",
  botName: "testbot",
  botToken: "xoxb-test-token",
  appToken: "xapp-test-token",
  signingSecret: "test-signing-secret",
  mode: "socket",
};

/**
 * A minimal but complete config for unit tests, with sensible overridable defaults.
 * Pass `{ app: {...} }` (singular) to override the one default app — the common case,
 * kept as sugar so single-app tests don't need to know about the `apps` array. Pass
 * `{ apps: [...] }` directly for genuine multi-app scenarios.
 */
export function makeConfig(overrides: Partial<any> = {}): Config {
  const { app, apps, ...rest } = overrides;
  return ConfigSchema.parse({
    workspace: { name: "Test Workspace", domain: "test-workspace", teamId: "T01TEST" },
    apps: apps ?? [{ ...DEFAULT_APP, ...app }],
    users: [
      { id: "U01ALICE", name: "alice", real_name: "Alice Anderson" },
      { id: "U02BOB", name: "bob", real_name: "Bob Brown" },
    ],
    channels: [
      { id: "C01GEN", name: "general", members: ["U01ALICE", "U02BOB", "U0BOT"] },
      { id: "C02RND", name: "random", members: ["U01ALICE", "U0BOT"] },
    ],
    ...rest,
  });
}

export function makeStore(overrides: Partial<any> = {}): Store {
  const store = new Store(makeConfig(overrides));
  store.runtime = { httpBase: "http://localhost:3000", wsBase: "ws://localhost:3000" };
  return store;
}

/** A BotGateway stub that records what would have been delivered (including which
 *  app it was addressed to) and returns a canned response, without touching sockets
 *  or the network. */
export function makeGatewayStub(response: unknown = undefined) {
  const calls: { kind: string; appId: string; payload: unknown }[] = [];
  const gateway = {
    deliverEvent: async (appId: string, event: unknown) => {
      calls.push({ kind: "event", appId, payload: event });
    },
    deliverSlashCommand: async (appId: string, cmd: unknown) => {
      calls.push({ kind: "slash", appId, payload: cmd });
      return response;
    },
    deliverInteractive: async (appId: string, payload: unknown) => {
      calls.push({ kind: "interactive", appId, payload });
      return response;
    },
  } as unknown as BotGateway;
  return { gateway, calls };
}

/** A full, valid MethodContext for calling `methods["..."]` directly in tests —
 *  a real (but disconnected) SocketManager and Interactions, a gateway stub, and
 *  `app` resolved to the store's primary app unless overridden. */
export function makeMethodContext(
  store: Store,
  overrides: { app?: AppConfig; response?: unknown } = {},
): MethodContext & { calls: { kind: string; appId: string; payload: unknown }[] } {
  const { gateway, calls } = makeGatewayStub(overrides.response);
  return {
    store,
    app: overrides.app ?? store.primaryApp(),
    gateway,
    socket: new SocketManager(store),
    interactions: new Interactions(store),
    calls,
  };
}
