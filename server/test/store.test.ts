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
    const first = store.openDm("U01ALICE", "U0BOT");
    const second = store.openDm("U01ALICE", "U0BOT");
    expect(first.id).toBe(second.id);
    expect(first.is_im).toBe(true);
    expect(first.members).toEqual(["U01ALICE", "U0BOT"]);
  });

  test("openDm opens separate DMs with different bots for the same user", () => {
    const store = makeStore();
    const withBot1 = store.openDm("U01ALICE", "U0BOT");
    const withBot2 = store.openDm("U01ALICE", "U9OTHERBOT");
    expect(withBot1.id).not.toBe(withBot2.id);
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

  test("publishHome stores a per-user, per-app home view", () => {
    const store = makeStore();
    store.publishHome("U01ALICE", "A01APP", { type: "home", blocks: [] });
    expect(store.homeViewsFor("U01ALICE")).toEqual({ A01APP: { type: "home", blocks: [] } });
  });

  test("publishHome keeps separate views per app for the same user", () => {
    const store = makeStore();
    store.publishHome("U01ALICE", "A1", { type: "home", blocks: [{ n: 1 }] });
    store.publishHome("U01ALICE", "A2", { type: "home", blocks: [{ n: 2 }] });
    const views = store.homeViewsFor("U01ALICE");
    expect(views.A1.blocks).toEqual([{ n: 1 }]);
    expect(views.A2.blocks).toEqual([{ n: 2 }]);
  });

  test("reset restores the config baseline and drops dynamically created state", () => {
    const store = makeStore();
    store.addMessage({ type: "message", ts: "1.000001", channel: "C01GEN", text: "hi" });
    store.openDm("U01ALICE", "U0BOT"); // creates a new DM channel
    store.publishHome("U01ALICE", "A01APP", { type: "home" });
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

describe("Store — multi-app", () => {
  function twoAppStore() {
    return makeStore({
      apps: [
        { appId: "A1", botUserId: "U1BOT", botName: "bot-one", botToken: "t1", mode: "socket" },
        { appId: "A2", botUserId: "U2BOT", botName: "bot-two", botToken: "t2", mode: "socket" },
      ],
      channels: [
        { id: "C01GEN", name: "general", members: ["U01ALICE", "U1BOT"] }, // only bot-one is here
      ],
    });
  }

  test("primaryApp / appById resolve configured apps", () => {
    const store = twoAppStore();
    expect(store.primaryApp().appId).toBe("A1");
    expect(store.appById("A2")?.botUserId).toBe("U2BOT");
    expect(store.appById("nope")).toBeUndefined();
  });

  test("appByToken matches either the bot or app-level token, falling back to primary", () => {
    const store = twoAppStore();
    expect(store.appByToken("t1")?.appId).toBe("A1");
    expect(store.appByToken("t2")?.appId).toBe("A2");
    expect(store.appByToken("unknown-token").appId).toBe("A1"); // lenient fallback
    expect(store.appByToken(undefined).appId).toBe("A1");
  });

  test("allUsers includes one synthesized bot user per configured app", () => {
    const store = twoAppStore();
    const bots = store.allBotUsers();
    expect(bots.map((b) => b.id)).toEqual(["U1BOT", "U2BOT"]);
    expect(store.allUsers().filter((u) => u.is_bot)).toHaveLength(2);
  });

  test("appsInChannel returns only apps whose bot is a member of that channel", () => {
    const store = twoAppStore();
    expect(store.appsInChannel("C01GEN").map((a) => a.appId)).toEqual(["A1"]);
    expect(store.appsInChannel("no-such-channel")).toEqual([]);
  });

  test("createChannel adds every configured app's bot as a member", () => {
    const store = twoAppStore();
    const channel = store.createChannel("new-room");
    expect(channel.members).toEqual(["U1BOT", "U2BOT"]);
  });
});
