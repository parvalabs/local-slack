import { Hono } from "hono";
import { parseArgs } from "./params.ts";
import { methods, type MethodContext } from "./methods.ts";

/** Hono sub-app implementing `POST /api/:method` (the Slack Web API surface).
 *  Takes everything a method needs except which app is calling — that's resolved
 *  fresh per request from the caller's Bearer token, since each app authenticates
 *  with its own bot/app-level token. */
export function webApiRouter(base: Omit<MethodContext, "app">) {
  const app = new Hono();

  app.post("/:method", async (c) => {
    const method = c.req.param("method");
    const { token, args } = await parseArgs(c.req);
    base.store.addLog("from_bot", "web_api", method, args);

    const handler = methods[method];
    if (!handler) {
      return c.json({ ok: false, error: "unknown_method" });
    }
    const ctx: MethodContext = { ...base, app: base.store.appByToken(token) };
    try {
      const result = await handler(args, ctx);
      if (result && result.ok === false) {
        base.store.addLog("internal", "web_api", `${method} -> ${result.error}`);
      }
      return c.json(result);
    } catch (e) {
      base.store.addLog("internal", "web_api", `${method} threw`, String(e));
      return c.json({ ok: false, error: "internal_error" });
    }
  });

  return app;
}
