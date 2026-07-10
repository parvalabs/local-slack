import { Hono, type Context } from "hono";
import { parseArgs } from "./params.ts";
import { methods, type MethodContext } from "./methods.ts";

/** Hono sub-app implementing the Slack Web API surface at `/api/:method`. Real
 *  Slack accepts both POST (args in the body) and GET (args in the query
 *  string) — some clients, e.g. Python's slack_sdk, use GET for read-only
 *  methods — so both are handled here, or a GET falls through to the SPA's
 *  catch-all route and the client chokes on an HTML response.
 *
 *  Takes everything a method needs except which app is calling — that's resolved
 *  fresh per request from the caller's Bearer token, since each app authenticates
 *  with its own bot/app-level token. */
export function webApiRouter(base: Omit<MethodContext, "app">) {
  const app = new Hono();

  const handle = async (c: Context) => {
    // Non-null: both registrations below match "/:method", so this param always exists.
    const method = c.req.param("method")!;
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
  };

  app.post("/:method", handle);
  app.get("/:method", handle);

  return app;
}
