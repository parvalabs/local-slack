import { createHmac } from "node:crypto";

/** Compute a Slack v0 request signature (HMAC-SHA256 over `v0:timestamp:body`). */
export function computeSignature(secret: string, timestamp: string | number, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  const hash = createHmac("sha256", secret).update(base).digest("hex");
  return `v0=${hash}`;
}

/** Headers Slack sends alongside signed HTTP deliveries (Events API / interactivity / slash). */
export function signedHeaders(
  secret: string,
  body: string,
  contentType: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    "Content-Type": contentType,
    "X-Slack-Signature": computeSignature(secret, timestamp, body),
    "X-Slack-Request-Timestamp": timestamp,
  };
}
