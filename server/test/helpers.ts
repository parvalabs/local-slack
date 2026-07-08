import { ConfigSchema, type Config } from "../src/config/schema.ts";
import { Store } from "../src/state/store.ts";
import type { BotGateway } from "../src/gateway/bot.ts";

/** A minimal but complete config for unit tests, with sensible overridable defaults. */
export function makeConfig(overrides: Partial<any> = {}): Config {
  return ConfigSchema.parse({
    workspace: { name: "Test Workspace", domain: "test-workspace", teamId: "T01TEST" },
    app: {
      appId: "A01APP",
      botUserId: "U0BOT",
      botName: "testbot",
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      signingSecret: "test-signing-secret",
      mode: "socket",
    },
    users: [
      { id: "U01ALICE", name: "alice", real_name: "Alice Anderson" },
      { id: "U02BOB", name: "bob", real_name: "Bob Brown" },
    ],
    channels: [
      { id: "C01GEN", name: "general", members: ["U01ALICE", "U02BOB", "U0BOT"] },
      { id: "C02RND", name: "random", members: ["U01ALICE", "U0BOT"] },
    ],
    ...overrides,
  });
}

export function makeStore(overrides: Partial<any> = {}): Store {
  const store = new Store(makeConfig(overrides));
  store.runtime = { httpBase: "http://localhost:3000", wsBase: "ws://localhost:3000" };
  return store;
}

/** A BotGateway stub that records what would have been delivered and returns
 *  a canned response, without touching sockets or the network. */
export function makeGatewayStub(response: unknown = undefined) {
  const calls: { kind: string; payload: unknown }[] = [];
  const gateway = {
    deliverEvent: async (event: unknown) => {
      calls.push({ kind: "event", payload: event });
    },
    deliverSlashCommand: async (cmd: unknown) => {
      calls.push({ kind: "slash", payload: cmd });
      return response;
    },
    deliverInteractive: async (payload: unknown) => {
      calls.push({ kind: "interactive", payload });
      return response;
    },
  } as unknown as BotGateway;
  return { gateway, calls };
}
