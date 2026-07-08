import type { HonoRequest } from "hono";

// Fields the Slack WebClient serializes as JSON strings inside a urlencoded body.
const JSON_FIELDS = ["blocks", "attachments", "view", "metadata"];

/**
 * Parse a Web API request body into a flat args object, handling the content types
 * @slack/web-api actually sends (urlencoded with JSON-stringified complex fields,
 * JSON, or multipart) and extracting the bearer token.
 */
export async function parseArgs(
  req: HonoRequest,
): Promise<{ token?: string; args: Record<string, any> }> {
  const contentType = (req.header("content-type") ?? "").toLowerCase();
  let args: Record<string, any> = {};

  if (contentType.includes("application/json")) {
    args = await req.json().catch(() => ({}));
  } else if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    for (const [k, v] of form.entries()) args[k] = v;
  } else {
    const params = new URLSearchParams(await req.text());
    for (const [k, v] of params.entries()) args[k] = v;
  }

  for (const field of JSON_FIELDS) {
    if (typeof args[field] === "string") {
      try {
        args[field] = JSON.parse(args[field]);
      } catch {
        /* leave as-is */
      }
    }
  }

  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : args.token;
  return { token, args };
}
