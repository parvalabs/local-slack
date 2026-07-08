import { describe, test, expect } from "bun:test";
import { userReaction, userEditMessage, userDeleteMessage } from "../src/actions.ts";
import { makeStore, makeGatewayStub } from "./helpers.ts";

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
