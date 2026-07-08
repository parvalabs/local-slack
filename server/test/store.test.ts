import { describe, test, expect } from "bun:test";
import { nextTs } from "../src/state/store.ts";
import { makeStore } from "./helpers.ts";

describe("nextTs", () => {
  test("has the seconds.microseconds shape", () => {
    expect(nextTs()).toMatch(/^\d+\.\d{6}$/);
  });

  test("is unique across consecutive calls", () => {
    const seen = new Set(Array.from({ length: 50 }, () => nextTs()));
    expect(seen.size).toBe(50);
  });
});

describe("Store", () => {
  test("seeds users/channels from config, plus a synthesized bot user", () => {
    const store = makeStore();
    expect(store.users.size).toBe(2);
    expect(store.channels.size).toBe(2);
    expect(store.botUserId).toBe("U0BOT");

    const all = store.allUsers();
    expect(all[0].id).toBe("U0BOT");
    expect(all[0].is_bot).toBe(true);
    expect(all).toHaveLength(3);
  });

  test("addMessage / findMessage / channelMessages", () => {
    const store = makeStore();
    const msg = store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", text: "hi" });
    expect(store.findMessage("C01GEN", "1.000001")).toBe(msg);
    expect(store.channelMessages("C01GEN")).toHaveLength(1);
    expect(store.channelMessages("C02RND")).toHaveLength(0);
  });

  test("addMessage lazily creates the channel's message list for unknown channels (e.g. a fresh DM)", () => {
    const store = makeStore();
    store.addMessage({ type: "message", ts: "1.000001", channel: "D999", text: "hi" });
    expect(store.channelMessages("D999")).toHaveLength(1);
  });

  test("updateMessage patches an existing message and emits message_update", () => {
    const store = makeStore();
    store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", text: "hi" });
    let emitted: any = null;
    store.on("message_update", (m) => (emitted = m));

    const updated = store.updateMessage("C01GEN", "1.000001", { text: "edited" });
    expect(updated?.text).toBe("edited");
    expect(emitted?.text).toBe("edited");
    expect(store.updateMessage("C01GEN", "does-not-exist", { text: "x" })).toBeUndefined();
  });

  test("deleteMessage removes a message and returns false for a missing one", () => {
    const store = makeStore();
    store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", text: "hi" });
    expect(store.deleteMessage("C01GEN", "1.000001")).toBe(true);
    expect(store.channelMessages("C01GEN")).toHaveLength(0);
    expect(store.deleteMessage("C01GEN", "1.000001")).toBe(false);
    expect(store.deleteMessage("no-such-channel", "1.000001")).toBe(false);
  });

  test("openDm creates a DM once and reuses it on subsequent calls", () => {
    const store = makeStore();
    const first = store.openDm("U01ALICE");
    const second = store.openDm("U01ALICE");
    expect(first.id).toBe(second.id);
    expect(first.is_im).toBe(true);
    expect(first.members).toEqual(["U01ALICE", "U0BOT"]);
  });

  test("createChannel makes a fresh public or private channel", () => {
    const store = makeStore();
    const pub = store.createChannel("new-channel");
    expect(pub.is_private).toBe(false);
    expect(pub.id.startsWith("C")).toBe(true);

    const priv = store.createChannel("secret", true);
    expect(priv.is_private).toBe(true);
    expect(priv.id.startsWith("G")).toBe(true);
  });

  test("modal stack: setRootView / pushView / updateView / popView / clearViews", () => {
    const store = makeStore();
    store.setRootView({ id: "V1", type: "modal" });
    expect(store.modalStack).toHaveLength(1);

    store.pushView({ id: "V2", type: "modal" });
    expect(store.modalStack).toHaveLength(2);
    expect(store.modalStack.at(-1)?.id).toBe("V2");

    store.updateView(undefined, { id: "V2", type: "modal", updated: true });
    expect(store.modalStack.at(-1)?.updated).toBe(true);

    store.popView();
    expect(store.modalStack).toHaveLength(1);

    store.clearViews();
    expect(store.modalStack).toHaveLength(0);
  });

  test("publishHome stores a per-user home view", () => {
    const store = makeStore();
    store.publishHome("U01ALICE", { type: "home", blocks: [] });
    expect(store.homeViews.get("U01ALICE")).toEqual({ type: "home", blocks: [] });
  });

  test("reset restores the config baseline and drops dynamically created state", () => {
    const store = makeStore();
    store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", text: "hi" });
    store.openDm("U01ALICE"); // creates a new DM channel
    store.publishHome("U01ALICE", { type: "home" });
    store.setRootView({ id: "V1" });
    store.addLog("internal", "test", "hello");

    expect(store.channels.size).toBe(3); // 2 config channels + 1 DM

    store.reset();

    expect(store.channels.size).toBe(2);
    expect(store.channelMessages("C01GEN")).toHaveLength(0);
    expect(store.homeViews.size).toBe(0);
    expect(store.modalStack).toHaveLength(0);
    expect(store.log).toHaveLength(0);
  });

  test("addLog caps the log at 1000 entries", () => {
    const store = makeStore();
    for (let i = 0; i < 1005; i++) store.addLog("internal", "test", `entry ${i}`);
    expect(store.log).toHaveLength(1000);
    expect(store.log[0].summary).toBe("entry 5"); // oldest 5 evicted
  });
});
