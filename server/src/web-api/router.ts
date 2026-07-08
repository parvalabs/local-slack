import { Hono } from "hono";
import { parseArgs } from "./params.ts";
import { methods, type MethodContext } from "./methods.ts";

/** Hono sub-app implementing `POST /api/:method` (the Slack Web API surface). */
export function webApiRouter(ctx: MethodContext) {
  const app = new Hono();

  app.post("/:method", async (c) => {
    const method = c.req.param("method");
    const { args } = await parseArgs(c.req);
    ctx.store.addLog("from_bot", "web_api", method, args);

    const handler = methods[method];
    if (!handler) {
      return c.json({ ok: false, error: "unknown_method" });
    }
    try {
      const result = await handler(args, ctx);
      if (result && result.ok === false) {
        ctx.store.addLog("internal", "web_api", `${method} -> ${result.error}`);
      }
      return c.json(result);
    } catch (e) {
      ctx.store.addLog("internal", "web_api", `${method} threw`, String(e));
      return c.json({ ok: false, error: "internal_error" });
    }
  });

  return app;
}
