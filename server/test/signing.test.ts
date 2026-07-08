import { describe, test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { computeSignature, signedHeaders } from "../src/signing.ts";

describe("computeSignature", () => {
  test("matches a manually computed Slack v0 signature", () => {
    const secret = "shh";
    const ts = "1531420618";
    const body = "token=abc&text=hello";
    const expected =
      "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
    expect(computeSignature(secret, ts, body)).toBe(expected);
  });

  test("is deterministic for identical inputs", () => {
    const a = computeSignature("secret", "1000", "body");
    const b = computeSignature("secret", "1000", "body");
    expect(a).toBe(b);
  });

  test("changes when the secret, timestamp, or body changes", () => {
    const base = computeSignature("secret", "1000", "body");
    expect(computeSignature("other-secret", "1000", "body")).not.toBe(base);
    expect(computeSignature("secret", "2000", "body")).not.toBe(base);
    expect(computeSignature("secret", "1000", "other-body")).not.toBe(base);
  });

  test("starts with the v0= prefix", () => {
    expect(computeSignature("s", "1", "b")).toMatch(/^v0=[0-9a-f]{64}$/);
  });
});

describe("signedHeaders", () => {
  test("produces headers whose signature verifies against the raw body", () => {
    const body = JSON.stringify({ hello: "world" });
    const headers = signedHeaders("my-secret", body, "application/json");

    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Slack-Request-Timestamp"]).toMatch(/^\d+$/);

    const recomputed = computeSignature(
      "my-secret",
      headers["X-Slack-Request-Timestamp"],
      body,
    );
    expect(headers["X-Slack-Signature"]).toBe(recomputed);
  });

  test("a forged signature does not match", () => {
    const body = "payload";
    const headers = signedHeaders("real-secret", body, "application/json");
    const forged = computeSignature("wrong-secret", headers["X-Slack-Request-Timestamp"], body);
    expect(headers["X-Slack-Signature"]).not.toBe(forged);
  });
});
