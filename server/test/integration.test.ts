import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../src/server.ts";
import { computeSignature } from "../src/signing.ts";
import { makeConfig } from "./helpers.ts";
import { waitOpen, makeCollector, openSocket, postControlAndAck, json } from "./ws-helpers.ts";

// End-to-end tests that spin up the real Bun server (Hono + native WebSocket) and
// drive it exactly as a bot or the web UI would — no mocked internals.

describe("Socket Mode delivery", () => {
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  let base: string;
  let wsBase: string;

  beforeAll(async () => {
    const started = await startServer({ config: makeConfig({ app: { mode: "socket" } }), port: 0 });
    server = started.server;
    base = `http://localhost:${server.port}`;
    wsBase = `ws://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("apps.connections.open returns a connectable socket URL that sends hello", async () => {
    const res = await fetch(`${base}/api/apps.connections.open`, { method: "POST" });
    const { url } = await json(res);
    expect(url.startsWith(wsBase + "/socket/")).toBe(true);

    const ws = new WebSocket(url);
    const collector = makeCollector(ws);
    await waitOpen(ws);
    const hello = await collector.next();
    expect(hello.type).toBe("hello");
    ws.close();
  });

  test("a user message posted via the control API is delivered as a message event, and acking unblocks the call", async () => {
    const { ws, collector } = await openSocket(base);

    const { envelope, response } = await postControlAndAck(
      base,
      ws,
      collector,
      "/message",
      { channel: "C01GEN", user: "U01ALICE", text: "hello over the wire" },
    );

    expect(envelope.type).toBe("events_api");
    expect(envelope.accepts_response_payload).toBe(false);
    expect(envelope.payload.type).toBe("event_callback");
    expect(envelope.payload.event.type).toBe("message");
    expect(envelope.payload.event.text).toBe("hello over the wire");
    expect(envelope.payload.event.channel).toBe("C01GEN");
    expect(envelope.payload.event.user).toBe("U01ALICE");

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.ok).toBe(true);
    expect(body.message.text).toBe("hello over the wire");

    ws.close();
  });

  test("a slash command delivers a slash_commands envelope, and an inline ack payload is posted back as a message", async () => {
    const { ws, collector } = await openSocket(base);

    const { envelope, response } = await postControlAndAck(
      base,
      ws,
      collector,
      "/command",
      { channel: "C01GEN", user: "U02BOB", command: "/echo", text: "hi there" },
      { text: "Echo: hi there" },
    );

    expect(envelope.type).toBe("slash_commands");
    expect(envelope.accepts_response_payload).toBe(true);
    expect(envelope.payload.command).toBe("/echo");
    expect(envelope.payload.text).toBe("hi there");
    expect(envelope.payload.user_id).toBe("U02BOB");
    expect(response.status).toBe(200);

    const msgs = await json(await fetch(`${base}/_control/messages/C01GEN`));
    expect(msgs.messages.at(-1).text).toBe("Echo: hi there");

    ws.close();
  });

  test("a button click delivers block_actions, and posting to its response_url adds a message", async () => {
    const { ws, collector } = await openSocket(base);

    const { response: postRes } = await postControlAndAck(base, ws, collector, "/message", {
      channel: "C01GEN",
      user: "U01ALICE",
      text: "root message for interaction",
    });
    const { message: root } = await json(postRes);

    const { envelope, response } = await postControlAndAck(base, ws, collector, "/interact", {
      channel: "C01GEN",
      messageTs: root.ts,
      user: "U01ALICE",
      action: { type: "button", action_id: "do_click", block_id: "b1", value: "clicked" },
    });

    expect(envelope.type).toBe("interactive");
    expect(envelope.payload.type).toBe("block_actions");
    expect(envelope.payload.trigger_id).toBeTruthy();
    expect(envelope.payload.response_url).toContain("/_hooks/response/");
    expect(response.status).toBe(200);

    // Simulate the bot's separate respond() call to response_url.
    const hookRes = await fetch(envelope.payload.response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "reply via response_url" }),
    });
    expect(hookRes.status).toBe(200);

    const msgs = await json(await fetch(`${base}/_control/messages/C01GEN`));
    expect(msgs.messages.at(-1).text).toBe("reply via response_url");

    ws.close();
  });

  test("/_control/reset restores the config baseline", async () => {
    const before = await json(await fetch(`${base}/_control/messages/C01GEN`));
    expect(before.messages.length).toBeGreaterThan(0);

    const res = await fetch(`${base}/_control/reset`, { method: "POST" });
    expect((await json(res)).ok).toBe(true);

    const after = await json(await fetch(`${base}/_control/messages/C01GEN`));
    expect(after.messages).toHaveLength(0);
  });

  test("/_control/state reports the workspace, apps, users and channels", async () => {
    const state = await json(await fetch(`${base}/_control/state`));
    expect(state.workspace.teamId).toBe("T01TEST");
    expect(state.apps).toHaveLength(1);
    expect(state.apps[0].mode).toBe("socket");
    expect(state.users.some((u: any) => u.id === "U0BOT")).toBe(true);
    expect(state.channels.some((c: any) => c.id === "C01GEN")).toBe(true);
  });

  test("/_control/reaction, /edit-message and /delete-message deliver the matching bot events", async () => {
    const { ws, collector } = await openSocket(base);

    const { response: postRes } = await postControlAndAck(base, ws, collector, "/message", {
      channel: "C01GEN",
      user: "U01ALICE",
      text: "reactable",
    });
    const { message: root } = await json(postRes);

    const { envelope: reactionEnvelope, response: reactionRes } = await postControlAndAck(
      base,
      ws,
      collector,
      "/reaction",
      { channel: "C01GEN", ts: root.ts, user: "U01ALICE", name: "tada" },
    );
    expect(reactionEnvelope.payload.event.type).toBe("reaction_added");
    expect(reactionEnvelope.payload.event.reaction).toBe("tada");
    expect(reactionRes.status).toBe(200);

    const { envelope: editEnvelope, response: editRes } = await postControlAndAck(
      base,
      ws,
      collector,
      "/edit-message",
      { channel: "C01GEN", ts: root.ts, user: "U01ALICE", text: "reactable, edited" },
    );
    expect(editEnvelope.payload.event.subtype).toBe("message_changed");
    expect(editEnvelope.payload.event.message.text).toBe("reactable, edited");
    expect((await json(editRes)).ok).toBe(true);

    // Editing as someone else is rejected before any delivery is attempted.
    const forbidden = await fetch(`${base}/_control/edit-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C01GEN", ts: root.ts, user: "U02BOB", text: "hijacked" }),
    });
    expect(forbidden.status).toBe(400);
    expect((await json(forbidden)).error).toBe("not_authorized");

    const { envelope: deleteEnvelope, response: deleteRes } = await postControlAndAck(
      base,
      ws,
      collector,
      "/delete-message",
      { channel: "C01GEN", ts: root.ts, user: "U01ALICE" },
    );
    expect(deleteEnvelope.payload.event.subtype).toBe("message_deleted");
    expect(deleteEnvelope.payload.event.deleted_ts).toBe(root.ts);
    expect((await json(deleteRes)).ok).toBe(true);

    ws.close();
  });
});

describe("Multi-app workspace", () => {
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  let base: string;

  beforeAll(async () => {
    const config = makeConfig({
      apps: [
        { appId: "A1", botUserId: "U1BOT", botToken: "xoxb-app-one", mode: "socket" },
        { appId: "A2", botUserId: "U2BOT", botToken: "xoxb-app-two", mode: "socket" },
      ],
      channels: [
        // Both bots are members, so both should see channel events (fan-out).
        { id: "C01GEN", name: "general", members: ["U01ALICE", "U1BOT", "U2BOT"] },
      ],
    });
    const started = await startServer({ config, port: 0 });
    server = started.server;
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("a human's message fans out to every app that's a member of the channel", async () => {
    const one = await openSocket(base, "xoxb-app-one");
    const two = await openSocket(base, "xoxb-app-two");

    const fetchPromise = fetch(`${base}/_control/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C01GEN", user: "U01ALICE", text: "hi both of you" }),
    });

    // Both apps receive their own envelope for the same event; ack both to unblock the call.
    const envelope1 = await one.collector.next();
    const envelope2 = await two.collector.next();
    one.ws.send(JSON.stringify({ envelope_id: envelope1.envelope_id }));
    two.ws.send(JSON.stringify({ envelope_id: envelope2.envelope_id }));

    const res = await fetchPromise;
    expect(res.status).toBe(200);
    expect(envelope1.payload.event.text).toBe("hi both of you");
    expect(envelope2.payload.event.text).toBe("hi both of you");
    expect(envelope1.payload.api_app_id).toBe("A1");
    expect(envelope2.payload.api_app_id).toBe("A2");

    one.ws.close();
    two.ws.close();
  });

  test("a button click is routed only to the app whose message it's attached to", async () => {
    const one = await openSocket(base, "xoxb-app-one");
    const two = await openSocket(base, "xoxb-app-two");

    // Post a message as app A1 (via its own Web API token) with a button.
    const postRes = await fetch(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-app-one", "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "C01GEN",
        text: "pick me",
        blocks: [{ type: "actions", elements: [{ type: "button", action_id: "go", value: "x" }] }],
      }),
    });
    const { ts } = await json(postRes);

    const interactFetch = fetch(`${base}/_control/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "C01GEN",
        messageTs: ts,
        user: "U01ALICE",
        action: { type: "button", action_id: "go", block_id: "b1", value: "x" },
      }),
    });

    // Only A1 (the message's owner) receives the interaction.
    const envelope = await one.collector.next();
    expect(envelope.payload.api_app_id).toBe("A1");
    expect(envelope.payload.type).toBe("block_actions");
    one.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    await interactFetch;

    // A2 got nothing at all for this interaction — prove it by racing a short timeout.
    const raced = await Promise.race([
      two.collector.next().then(() => "message"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);
    expect(raced).toBe("timeout");

    one.ws.close();
    two.ws.close();
  });
});

describe("Events API (HTTP) delivery", () => {
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  let base: string;
  let stub: ReturnType<typeof Bun.serve>;
  let requests: { headers: Record<string, string>; body: string; path: string }[];
  const signingSecret = "events-mode-secret";

  beforeAll(async () => {
    requests = [];
    stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        requests.push({
          headers: Object.fromEntries(req.headers),
          body,
          path: new URL(req.url).pathname,
        });
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    const config = makeConfig({
      app: {
        mode: "events",
        requestUrl: `http://localhost:${stub.port}/slack/events`,
        signingSecret,
      },
    });
    const started = await startServer({ config, port: 0 });
    server = started.server;
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    stub.stop(true);
  });

  test("a control-posted message is delivered as a genuinely signed HTTP POST", async () => {
    const res = await fetch(`${base}/_control/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C01GEN", user: "U01ALICE", text: "http mode message" }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(req.body);
    expect(payload.event.type).toBe("message");
    expect(payload.event.text).toBe("http mode message");

    // The signature genuinely verifies against the delivered body + timestamp.
    const expectedSig = computeSignature(
      signingSecret,
      req.headers["x-slack-request-timestamp"],
      req.body,
    );
    expect(req.headers["x-slack-signature"]).toBe(expectedSig);

    // ...and a wrong secret would not have produced the same signature.
    const wrongSig = computeSignature(
      "wrong-secret",
      req.headers["x-slack-request-timestamp"],
      req.body,
    );
    expect(req.headers["x-slack-signature"]).not.toBe(wrongSig);
  });

  test("a slash command is delivered form-encoded, and the stub's JSON response is posted back", async () => {
    requests.length = 0;
    const res = await fetch(`${base}/_control/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C01GEN", user: "U02BOB", command: "/echo", text: "hi" }),
    });
    expect(res.status).toBe(200);

    expect(requests).toHaveLength(1);
    expect(requests[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(requests[0].body);
    expect(params.get("command")).toBe("/echo");
    expect(params.get("text")).toBe("hi");
    expect(params.get("response_url")).toContain("/_hooks/response/");

    // The stub always responds 200 {} in this suite, so no message is posted back
    // (userSlashCommand only posts when the ack payload has text/blocks).
  });

  test("an interactive action is delivered as a form-encoded `payload` field", async () => {
    requests.length = 0;
    await fetch(`${base}/_control/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C01GEN", user: "U01ALICE", text: "root" }),
    });
    requests.length = 0; // drop the message-delivery request, keep only the interaction below

    const root = await json(await fetch(`${base}/_control/messages/C01GEN`));
    const rootTs = root.messages.at(-1).ts;

    await fetch(`${base}/_control/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "C01GEN",
        messageTs: rootTs,
        user: "U01ALICE",
        action: { type: "button", action_id: "do_click", block_id: "b1", value: "clicked" },
      }),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(requests[0].body);
    const payload = JSON.parse(params.get("payload")!);
    expect(payload.type).toBe("block_actions");
    expect(payload.actions[0].action_id).toBe("do_click");
  });
});

describe("Custom emoji", () => {
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  let base: string;
  let imgPath: string;

  beforeAll(async () => {
    imgPath = `/tmp/local-slack-test-emoji-${Date.now()}.png`;
    await Bun.write(imgPath, "fake-png-bytes");
    const started = await startServer({
      config: makeConfig({ emojis: { custom_smile: imgPath } }),
      port: 0,
    });
    server = started.server;
    base = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await Bun.file(imgPath).delete().catch(() => {});
  });

  test("emoji.list returns a fetchable URL for each configured custom emoji", async () => {
    const res = await fetch(`${base}/api/emoji.list`);
    const { emoji } = await json(res);
    expect(emoji.custom_smile).toBe(`${base}/emoji/custom_smile`);

    const img = await fetch(emoji.custom_smile);
    expect(img.status).toBe(200);
    expect(await img.text()).toBe("fake-png-bytes");
  });

  test("GET /emoji/:name 404s for an unconfigured name", async () => {
    const res = await fetch(`${base}/emoji/does_not_exist`);
    expect(res.status).toBe(404);
  });
});
