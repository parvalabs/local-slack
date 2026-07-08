import { Hono } from "hono";
import type { Store } from "../state/store.ts";
import type { BotGateway } from "../gateway/bot.ts";
import type { Interactions } from "../interactions.ts";
import {
  userPostMessage,
  userBlockAction,
  userSlashCommand,
  openAppHome,
} from "../actions.ts";

/**
 * Programmatic control surface for automated tests / scripting — drive the
 * workspace and inspect bot traffic without the UI.
 */
export function controlRouter(store: Store, gateway: BotGateway, interactions: Interactions) {
  const app = new Hono();

  app.get("/state", (c) =>
    c.json({
      workspace: store.config.workspace,
      app: { appId: store.config.app.appId, botUserId: store.botUserId, mode: store.config.app.mode },
      users: store.allUsers(),
      channels: [...store.channels.values()],
    }),
  );

  app.get("/log", (c) => c.json({ log: store.log }));

  app.get("/messages/:channel", (c) =>
    c.json({ messages: store.channelMessages(c.req.param("channel")) }),
  );

  // Simulate a user posting a message (or a slash command if text starts with "/").
  app.post("/message", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    if (!body.channel || !body.user) {
      return c.json({ ok: false, error: "channel and user are required" }, 400);
    }
    const message = await userPostMessage(store, gateway, {
      channel: body.channel,
      user: body.user,
      text: body.text,
      thread_ts: body.thread_ts,
    });
    return c.json({ ok: true, message });
  });

  // Simulate a slash command.
  app.post("/command", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    if (!body.channel || !body.user || !body.command) {
      return c.json({ ok: false, error: "channel, user and command are required" }, 400);
    }
    await userSlashCommand(store, gateway, interactions, {
      channel: body.channel,
      user: body.user,
      command: body.command,
      text: body.text ?? "",
    });
    return c.json({ ok: true });
  });

  // Simulate clicking an interactive element.
  app.post("/interact", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    if (!body.channel || !body.messageTs || !body.user || !body.action) {
      return c.json({ ok: false, error: "channel, messageTs, user and action are required" }, 400);
    }
    await userBlockAction(store, gateway, interactions, {
      channel: body.channel,
      messageTs: body.messageTs,
      user: body.user,
      action: body.action,
    });
    return c.json({ ok: true });
  });

  // Simulate opening the App Home.
  app.post("/open-home", async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    if (!body.user) return c.json({ ok: false, error: "user is required" }, 400);
    await openAppHome(store, gateway, { user: body.user });
    return c.json({ ok: true });
  });

  // Restore the workspace to its config baseline.
  app.post("/reset", (c) => {
    store.reset();
    return c.json({ ok: true });
  });

  return app;
}
