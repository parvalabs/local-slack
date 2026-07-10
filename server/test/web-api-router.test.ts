import { describe, test, expect } from "bun:test";
import { webApiRouter } from "../src/web-api/router.ts";
import { Interactions } from "../src/interactions.ts";
import { SocketManager } from "../src/socket/manager.ts";
import { makeStore, makeGatewayStub } from "./helpers.ts";
import { json } from "./ws-helpers.ts";

function makeApp(storeOverrides: Partial<any> = {}) {
  const store = makeStore(storeOverrides);
  const { gateway } = makeGatewayStub();
  const interactions = new Interactions(store);
  const socket = new SocketManager(store);
  const app = webApiRouter({ store, gateway, socket, interactions });
  return { app, store };
}

describe("webApiRouter", () => {
  test("unknown methods return ok:false without throwing", async () => {
    const { app } = makeApp();
    const res = await app.request("/definitely.not.a.method", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "unknown_method" });
  });

  test("accepts JSON bodies", async () => {
    const { app } = makeApp();
    const res = await app.request("/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C01GEN", text: "via json" }),
    });
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.message.text).toBe("via json");
  });

  test("accepts form-urlencoded bodies with JSON-stringified blocks (as @slack/web-api sends)", async () => {
    const { app } = makeApp();
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
    const params = new URLSearchParams({ channel: "C01GEN", text: "via form", blocks: JSON.stringify(blocks) });
    const res = await app.request("/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.message.blocks).toEqual(blocks);
  });

  test("accepts args passed as query-string parameters on a POST, no body at all (as slack_sdk's AsyncWebClient sends reactions.add/remove via aiohttp's params=)", async () => {
    const { app } = makeApp();
    const posted = await app.request("/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C01GEN", text: "react to me" }),
    });
    const { ts } = await json(posted);

    const res = await app.request(
      `/reactions.add?channel=C01GEN&timestamp=${ts}&name=thumbsup`,
      { method: "POST" },
    );
    expect(await json(res)).toEqual({ ok: true });
  });

  test("when both query string and body carry the same key, the body wins", async () => {
    const { app } = makeApp();
    const res = await app.request("/chat.postMessage?text=from+query", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channel: "C01GEN", text: "from body" }).toString(),
    });
    const body = await json(res);
    expect(body.message.text).toBe("from body");
  });

  test("a handler throwing is caught and reported as internal_error", async () => {
    const { app, store } = makeApp();
    const original = store.channels.get.bind(store.channels);
    store.channels.get = () => {
      throw new Error("boom");
    };
    try {
      const res = await app.request("/conversations.info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "C01GEN" }),
      });
      const body = await json(res);
      expect(body).toEqual({ ok: false, error: "internal_error" });
      expect(store.log.some((e) => e.summary === "conversations.info threw")).toBe(true);
    } finally {
      store.channels.get = original;
    }
  });

  test("every call is recorded in the log for the Inspector", async () => {
    const { app, store } = makeApp();
    await app.request("/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "C01GEN", text: "logged?" }),
    });
    expect(store.log.some((e) => e.kind === "web_api" && e.summary === "chat.postMessage")).toBe(
      true,
    );
  });

  test("reads the bearer token from the Authorization header", async () => {
    const { app } = makeApp();
    // auth.test doesn't use the token, but we can confirm the request succeeds with one present.
    const res = await app.request("/auth.test", {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-test-token" },
    });
    expect((await json(res)).ok).toBe(true);
  });

  test("with multiple apps configured, resolves the calling app from its own token", async () => {
    const { app } = makeApp({
      apps: [
        { appId: "A1", botUserId: "U1BOT", botToken: "xoxb-one", mode: "socket" },
        { appId: "A2", botUserId: "U2BOT", botToken: "xoxb-two", mode: "socket" },
      ],
    });

    const asOne = await app.request("/auth.test", {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-one" },
    });
    expect((await json(asOne)).user_id).toBe("U1BOT");

    const asTwo = await app.request("/auth.test", {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-two" },
    });
    expect((await json(asTwo)).user_id).toBe("U2BOT");

    // An unrecognized token falls back to the first configured app (this mock
    // doesn't hard-enforce auth) rather than failing the call outright.
    const unknownToken = await app.request("/auth.test", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect((await json(unknownToken)).user_id).toBe("U1BOT");
  });
});
