import { describe, test, expect } from "bun:test";
import { methods } from "../src/web-api/methods.ts";
import { makeStore, makeMethodContext } from "./helpers.ts";

const ctxFor = makeMethodContext;

describe("auth.test / apps.connections.open / team.info / bots.info", () => {
  test("auth.test identifies the bot", () => {
    const store = makeStore();
    const res = methods["auth.test"]({}, ctxFor(store));
    expect(res.ok).toBe(true);
    expect(res.user_id).toBe("U0BOT");
    expect(res.team_id).toBe("T01TEST");
    expect(res.bot_id).toBe("B0BOT");
  });

  test("apps.connections.open returns a ws:// url rooted at the store's wsBase", () => {
    const store = makeStore();
    const res = methods["apps.connections.open"]({}, ctxFor(store));
    expect(res.ok).toBe(true);
    expect(res.url.startsWith("ws://localhost:3000/socket/")).toBe(true);
  });

  test("team.info / bots.info", () => {
    const store = makeStore();
    expect(methods["team.info"]({}, ctxFor(store)).team.name).toBe("Test Workspace");
    expect(methods["bots.info"]({}, ctxFor(store)).bot.user_id).toBe("U0BOT");
  });
});

describe("chat.*", () => {
  test("chat.postMessage stores and returns the message", () => {
    const store = makeStore();
    const res = methods["chat.postMessage"]({ channel: "C01GEN", text: "hi" }, ctxFor(store));
    expect(res.ok).toBe(true);
    expect(res.channel).toBe("C01GEN");
    expect(store.channelMessages("C01GEN")).toHaveLength(1);
    expect(res.message.bot_id).toBe("B0BOT");
  });

  test("chat.postMessage errors on an unknown channel", () => {
    const store = makeStore();
    const res = methods["chat.postMessage"]({ channel: "no-such", text: "hi" }, ctxFor(store));
    expect(res).toEqual({ ok: false, error: "channel_not_found" });
  });

  test("chat.update edits an existing message and errors on a missing one", () => {
    const store = makeStore();
    const posted = methods["chat.postMessage"]({ channel: "C01GEN", text: "hi" }, ctxFor(store));
    const res = methods["chat.update"](
      { channel: "C01GEN", ts: posted.ts, text: "edited" },
      ctxFor(store),
    );
    expect(res.ok).toBe(true);
    expect(res.text).toBe("edited");

    const missing = methods["chat.update"](
      { channel: "C01GEN", ts: "9.999999", text: "x" },
      ctxFor(store),
    );
    expect(missing).toEqual({ ok: false, error: "message_not_found" });
  });

  test("chat.delete removes a message and errors on a missing one", () => {
    const store = makeStore();
    const posted = methods["chat.postMessage"]({ channel: "C01GEN", text: "hi" }, ctxFor(store));
    expect(methods["chat.delete"]({ channel: "C01GEN", ts: posted.ts }, ctxFor(store)).ok).toBe(
      true,
    );
    expect(store.channelMessages("C01GEN")).toHaveLength(0);
    expect(
      methods["chat.delete"]({ channel: "C01GEN", ts: posted.ts }, ctxFor(store)),
    ).toEqual({ ok: false, error: "message_not_found" });
  });

  test("chat.postEphemeral tags the message ephemeral_to the target user", () => {
    const store = makeStore();
    const res = methods["chat.postEphemeral"](
      { channel: "C01GEN", user: "U01ALICE", text: "just for you" },
      ctxFor(store),
    );
    expect(res.ok).toBe(true);
    const stored = store.channelMessages("C01GEN")[0] as any;
    expect(stored.subtype).toBe("ephemeral");
    expect(stored.ephemeral_to).toBe("U01ALICE");
  });
});

describe("conversations.*", () => {
  test("conversations.list respects the types filter for im vs channels", () => {
    const store = makeStore();
    store.openDm("U01ALICE", store.primaryApp().botUserId);
    const channelsOnly = methods["conversations.list"]({}, ctxFor(store));
    expect(channelsOnly.channels.every((c: any) => !c.is_im)).toBe(true);

    const withIm = methods["conversations.list"]({ types: "public_channel,im" }, ctxFor(store));
    expect(withIm.channels.some((c: any) => c.is_im)).toBe(true);
  });

  test("conversations.info errors on an unknown channel", () => {
    const store = makeStore();
    expect(methods["conversations.info"]({ channel: "nope" }, ctxFor(store))).toEqual({
      ok: false,
      error: "channel_not_found",
    });
  });

  test("conversations.history returns newest-first and attaches thread meta to parents with replies", () => {
    const store = makeStore();
    const root = methods["chat.postMessage"]({ channel: "C01GEN", text: "root" }, ctxFor(store));
    methods["chat.postMessage"](
      { channel: "C01GEN", text: "reply 1", thread_ts: root.ts },
      ctxFor(store),
    );
    methods["chat.postMessage"](
      { channel: "C01GEN", text: "reply 2", thread_ts: root.ts },
      ctxFor(store),
    );

    const history = methods["conversations.history"]({ channel: "C01GEN" }, ctxFor(store));
    // Only the root shows up in history (replies are nested under the thread).
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].reply_count).toBe(2);
    expect(history.messages[0].reply_users_count).toBe(1); // both replies posted as the bot
    expect(history.messages[0].thread_ts).toBe(root.ts);
  });

  test("conversations.replies returns the root plus its replies in order", () => {
    const store = makeStore();
    const root = methods["chat.postMessage"]({ channel: "C01GEN", text: "root" }, ctxFor(store));
    methods["chat.postMessage"](
      { channel: "C01GEN", text: "reply 1", thread_ts: root.ts },
      ctxFor(store),
    );

    const replies = methods["conversations.replies"]({ channel: "C01GEN", ts: root.ts }, ctxFor(store));
    expect(replies.messages).toHaveLength(2);
    expect(replies.messages[0].ts).toBe(root.ts);
    expect(replies.messages[1].text).toBe("reply 1");
  });

  test("conversations.open opens (and reuses) a DM by user id", () => {
    const store = makeStore();
    const a = methods["conversations.open"]({ users: "U01ALICE" }, ctxFor(store));
    const b = methods["conversations.open"]({ users: "U01ALICE" }, ctxFor(store));
    expect(a.channel.id).toBe(b.channel.id);
  });

  test("conversations.create makes a new channel", () => {
    const store = makeStore();
    const res = methods["conversations.create"]({ name: "new-room", is_private: true }, ctxFor(store));
    expect(res.ok).toBe(true);
    expect(res.channel.name).toBe("new-room");
    expect(res.channel.is_private).toBe(true);
  });
});

describe("users.*", () => {
  test("users.list includes the bot", () => {
    const store = makeStore();
    const res = methods["users.list"]({}, ctxFor(store));
    expect(res.members.some((u: any) => u.id === "U0BOT")).toBe(true);
    expect(res.members).toHaveLength(3);
  });

  test("users.info errors for an unknown user", () => {
    const store = makeStore();
    expect(methods["users.info"]({ user: "nope" }, ctxFor(store))).toEqual({
      ok: false,
      error: "user_not_found",
    });
  });

  test("users.lookupByEmail finds a matching user", () => {
    const store = makeStore({
      users: [{ id: "U01ALICE", name: "alice", email: "alice@example.com" }],
    });
    const res = methods["users.lookupByEmail"]({ email: "alice@example.com" }, ctxFor(store));
    expect(res.user.id).toBe("U01ALICE");
  });
});

describe("views.*", () => {
  test("views.open requires a valid trigger_id", () => {
    const store = makeStore();
    const ctx = ctxFor(store);

    const withoutTrigger = methods["views.open"](
      { trigger_id: "bogus", view: { type: "modal" } },
      ctx,
    );
    expect(withoutTrigger).toEqual({ ok: false, error: "invalid_trigger_id" });

    const triggerId = ctx.interactions.newTriggerId(ctx.app, { user: "U01ALICE" });
    const res = methods["views.open"](
      { trigger_id: triggerId, view: { type: "modal", title: { text: "Hi" } } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(store.modalStack).toHaveLength(1);
    expect(res.view.id).toBeTruthy();
  });

  test("views.publish stores a home view for the given user, scoped to the publishing app", () => {
    const store = makeStore();
    const ctx = ctxFor(store);
    const res = methods["views.publish"](
      { user_id: "U01ALICE", view: { type: "home", blocks: [] } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(store.homeViewsFor("U01ALICE")[ctx.app.appId]?.type).toBe("home");
  });
});

describe("reactions.*", () => {
  test("reactions.add then reactions.remove round-trips on a message", () => {
    const store = makeStore();
    const posted = methods["chat.postMessage"]({ channel: "C01GEN", text: "hi" }, ctxFor(store));

    methods["reactions.add"]({ channel: "C01GEN", timestamp: posted.ts, name: "+1" }, ctxFor(store));
    let msg = store.findMessage("C01GEN", posted.ts) as any;
    expect(msg.reactions).toEqual([{ name: "+1", users: ["U0BOT"], count: 1 }]);

    // Adding the same reaction again from the same "user" (the bot) doesn't double count.
    methods["reactions.add"]({ channel: "C01GEN", timestamp: posted.ts, name: "+1" }, ctxFor(store));
    msg = store.findMessage("C01GEN", posted.ts) as any;
    expect(msg.reactions[0].count).toBe(1);

    methods["reactions.remove"](
      { channel: "C01GEN", timestamp: posted.ts, name: "+1" },
      ctxFor(store),
    );
    msg = store.findMessage("C01GEN", posted.ts) as any;
    expect(msg.reactions).toEqual([]);
  });

  test("reactions.add errors on a missing message", () => {
    const store = makeStore();
    expect(
      methods["reactions.add"]({ channel: "C01GEN", timestamp: "9.999999", name: "+1" }, ctxFor(store)),
    ).toEqual({ ok: false, error: "message_not_found" });
  });
});

describe("unknown method", () => {
  test("returns ok:false via the router, not methods directly (see web-api router)", () => {
    expect(methods["definitely.not.a.method"]).toBeUndefined();
  });
});
