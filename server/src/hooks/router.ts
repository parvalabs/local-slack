import { Hono } from "hono";
import { nextTs, type Store } from "../state/store.ts";
import type { Interactions } from "../interactions.ts";
import { botId } from "../web-api/format.ts";

/**
 * Handles `response_url` posts — what Bolt's `respond()` / `ack({ text })` call
 * for slash commands and block actions (post / replace / delete the message).
 */
export function hooksRouter(store: Store, interactions: Interactions) {
  const app = new Hono();

  app.post("/response/:id", async (c) => {
    const ctx = interactions.getResponseCtx(c.req.param("id"));
    if (!ctx) return c.json({ ok: false, error: "expired_url" }, 404);
    const body: any = await c.req.json().catch(() => ({}));

    if (body.delete_original && ctx.messageTs) {
      store.deleteMessage(ctx.channel, ctx.messageTs);
    } else if (body.replace_original && ctx.messageTs) {
      store.updateMessage(ctx.channel, ctx.messageTs, { text: body.text, blocks: body.blocks });
    } else {
      const ephemeral = body.response_type === "ephemeral";
      store.addMessage({
        type: "message",
        ts: nextTs(),
        channel: ctx.channel,
        user: store.botUserId,
        bot_id: botId(store),
        text: body.text ?? "",
        ...(body.blocks ? { blocks: body.blocks } : {}),
        ...(ephemeral ? { subtype: "ephemeral", ephemeral_to: ctx.user } : {}),
      } as any);
    }
    return c.text("");
  });

  return app;
}
