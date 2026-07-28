import { describe, test, expect } from "bun:test";
import { userPostMessage, userReaction, userEditMessage, userDeleteMessage } from "../src/actions.ts";
import { makeStore, makeGatewayStub } from "./helpers.ts";

describe("userPostMessage — app_mention", () => {
  const MULTI_APP = {
    apps: [
      { appId: "A1", botUserId: "U1BOT", botToken: "xoxb-one", mode: "socket" },
      { appId: "A2", botUserId: "U2BOT", botToken: "xoxb-two", mode: "socket" },
    ],
    channels: [
      { id: "C01GEN", name: "general", members: ["U01ALICE", "U1BOT", "U2BOT"] },
      // A2's bot is deliberately not a member here.
      { id: "C02RND", name: "random", members: ["U01ALICE", "U1BOT"] },
    ],
  };

  test("delivers app_mention alongside the message event when a bot is mentioned", async () => {
    const store = makeStore();
    const { gateway, calls } = makeGatewayStub();

    await userPostMessage(store, gateway, {
      channel: "C01GEN",
      user: "U01ALICE",
      text: "<@U0BOT> can you help?",
    });

    expect(calls.map((c) => (c.payload as any).type)).toEqual(["message", "app_mention"]);
    expect(calls[1]).toMatchObject({ kind: "event", appId: "A01APP" });
    expect(calls[1].payload).toMatchObject({
      type: "app_mention",
      user: "U01ALICE",
      text: "<@U0BOT> can you help?",
      channel: "C01GEN",
    });
  });

  test("delivers no app_mention when the message mentions nobody", async () => {
    const store = makeStore();
    const { gateway, calls } = makeGatewayStub();
    await userPostMessage(store, gateway, { channel: "C01GEN", user: "U01ALICE", text: "just chatting" });
    expect(calls.map((c) => (c.payload as any).type)).toEqual(["message"]);
  });

  test("mentioning a human doesn't produce an app_mention", async () => {
    const store = makeStore();
    const { gateway, calls } = makeGatewayStub();
    await userPostMessage(store, gateway, { channel: "C01GEN", user: "U01ALICE", text: "hey <@U02BOB>" });
    expect(calls.map((c) => (c.payload as any).type)).toEqual(["message"]);
  });

  test("routes app_mention only to the app that was named, not every app in the channel", async () => {
    const store = makeStore(MULTI_APP);
    const { gateway, calls } = makeGatewayStub();

    await userPostMessage(store, gateway, { channel: "C01GEN", user: "U01ALICE", text: "<@U2BOT> ping" });

    const mentions = calls.filter((c) => (c.payload as any).type === "app_mention");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].appId).toBe("A2");
  });

  test("mentioning several apps in one message delivers one app_mention each", async () => {
    const store = makeStore(MULTI_APP);
    const { gateway, calls } = makeGatewayStub();

    await userPostMessage(store, gateway, { channel: "C01GEN", user: "U01ALICE", text: "<@U1BOT> <@U2BOT> both" });

    const mentions = calls.filter((c) => (c.payload as any).type === "app_mention");
    expect(mentions.map((m) => m.appId).sort()).toEqual(["A1", "A2"]);
  });

  test("ignores a mention of an app that isn't in the channel", async () => {
    const store = makeStore(MULTI_APP);
    const { gateway, calls } = makeGatewayStub();

    await userPostMessage(store, gateway, { channel: "C02RND", user: "U01ALICE", text: "<@U2BOT> you can't see this" });

    expect(calls.filter((c) => (c.payload as any).type === "app_mention")).toHaveLength(0);
  });

  test("carries thread_ts through so a mention inside a thread stays in that thread", async () => {
    const store = makeStore();
    const { gateway, calls } = makeGatewayStub();

    await userPostMessage(store, gateway, {
      channel: "C01GEN",
      user: "U01ALICE",
      text: "<@U0BOT> in here",
      thread_ts: "1.000001",
    });

    const mention = calls.find((c) => (c.payload as any).type === "app_mention")!;
    expect(mention.payload).toMatchObject({ thread_ts: "1.000001" });
  });
});

describe("userReaction", () => {
  test("adds then removes a reaction, delivering reaction_added / reaction_removed events", async () => {
    const store = makeStore();
    const posted = store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", user: "U02BOB", text: "hi" });
    const { gateway, calls } = makeGatewayStub();

    await userReaction(store, gateway, { channel: "C01GEN", ts: posted.ts, user: "U01ALICE", name: "tada", present: true });
    expect(store.findMessage("C01GEN", posted.ts)?.reactions).toEqual([
      { name: "tada", users: ["U01ALICE"], count: 1 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({
      type: "reaction_added",
      user: "U01ALICE",
      reaction: "tada",
      item: { type: "message", channel: "C01GEN", ts: posted.ts },
      item_user: "U02BOB",
    });

    await userReaction(store, gateway, { channel: "C01GEN", ts: posted.ts, user: "U01ALICE", name: "tada", present: false });
    expect(store.findMessage("C01GEN", posted.ts)?.reactions).toEqual([]);
    expect(calls[1].payload).toMatchObject({ type: "reaction_removed", user: "U01ALICE", reaction: "tada" });
  });

  test("no-ops (and delivers nothing) for a message that doesn't exist", async () => {
    const store = makeStore();
    const { gateway, calls } = makeGatewayStub();
    await userReaction(store, gateway, { channel: "C01GEN", ts: "9.999999", user: "U01ALICE", name: "x", present: true });
    expect(calls).toHaveLength(0);
  });
});

describe("userEditMessage", () => {
  test("edits the author's own message and delivers a message_changed event", async () => {
    const store = makeStore();
    const posted = store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", user: "U01ALICE", text: "original" });
    const { gateway, calls } = makeGatewayStub();

    const result = await userEditMessage(store, gateway, { channel: "C01GEN", ts: posted.ts, user: "U01ALICE", text: "updated" });
    expect(result.ok).toBe(true);
    expect(result.message?.text).toBe("updated");
    expect(result.message?.edited?.user).toBe("U01ALICE");

    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({
      type: "message",
      subtype: "message_changed",
      channel: "C01GEN",
      message: { text: "updated" },
      previous_message: { text: "original" },
    });
  });

  test("refuses to edit another user's message", async () => {
    const store = makeStore();
    const posted = store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", user: "U01ALICE", text: "original" });
    const { gateway, calls } = makeGatewayStub();

    const result = await userEditMessage(store, gateway, { channel: "C01GEN", ts: posted.ts, user: "U02BOB", text: "hijacked" });
    expect(result).toEqual({ ok: false, error: "not_authorized" });
    expect(store.findMessage("C01GEN", posted.ts)?.text).toBe("original");
    expect(calls).toHaveLength(0);
  });

  test("refuses to edit a bot's message (no user match)", async () => {
    const store = makeStore();
    const posted = store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", user: store.botUserId, bot_id: "B0BOT", text: "bot said this" });
    const { gateway, calls } = makeGatewayStub();

    const result = await userEditMessage(store, gateway, { channel: "C01GEN", ts: posted.ts, user: "U01ALICE", text: "hijacked" });
    expect(result).toEqual({ ok: false, error: "not_authorized" });
    expect(calls).toHaveLength(0);
  });

  test("errors on a missing message", async () => {
    const store = makeStore();
    const { gateway } = makeGatewayStub();
    const result = await userEditMessage(store, gateway, { channel: "C01GEN", ts: "9.999999", user: "U01ALICE", text: "x" });
    expect(result).toEqual({ ok: false, error: "message_not_found" });
  });
});

describe("userDeleteMessage", () => {
  test("deletes the author's own message and delivers a message_deleted event", async () => {
    const store = makeStore();
    const posted = store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", user: "U01ALICE", text: "bye" });
    const { gateway, calls } = makeGatewayStub();

    const result = await userDeleteMessage(store, gateway, { channel: "C01GEN", ts: posted.ts, user: "U01ALICE" });
    expect(result).toEqual({ ok: true });
    expect(store.findMessage("C01GEN", posted.ts)).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({
      type: "message",
      subtype: "message_deleted",
      channel: "C01GEN",
      deleted_ts: posted.ts,
      previous_message: { text: "bye" },
    });
  });

  test("refuses to delete another user's message", async () => {
    const store = makeStore();
    const posted = store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", user: "U01ALICE", text: "keep me" });
    const { gateway, calls } = makeGatewayStub();

    const result = await userDeleteMessage(store, gateway, { channel: "C01GEN", ts: posted.ts, user: "U02BOB" });
    expect(result).toEqual({ ok: false, error: "not_authorized" });
    expect(store.findMessage("C01GEN", posted.ts)).toBeDefined();
    expect(calls).toHaveLength(0);
  });
});
