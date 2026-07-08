import { describe, test, expect } from "bun:test";
import { Interactions } from "../src/interactions.ts";
import { makeStore } from "./helpers.ts";

describe("Interactions — trigger_id", () => {
  test("newTriggerId issues an id that consumeTrigger can resolve", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const id = interactions.newTriggerId({ user: "U01ALICE", channel: "C01GEN" });
    const ctx = interactions.consumeTrigger(id);
    expect(ctx?.user).toBe("U01ALICE");
    expect(ctx?.channel).toBe("C01GEN");
  });

  test("consumeTrigger returns undefined for an unknown or missing id", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    expect(interactions.consumeTrigger("nope")).toBeUndefined();
    expect(interactions.consumeTrigger(undefined)).toBeUndefined();
  });

  test("a trigger_id survives a second consume within its TTL (open then push)", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const id = interactions.newTriggerId({ user: "U01ALICE" });
    expect(interactions.consumeTrigger(id)).toBeDefined();
    expect(interactions.consumeTrigger(id)).toBeDefined();
  });
});

describe("Interactions — response_url", () => {
  test("newResponseUrl is rooted at the store's httpBase and resolves via getResponseCtx", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const url = interactions.newResponseUrl({ channel: "C01GEN", user: "U01ALICE" });
    expect(url.startsWith("http://localhost:3000/_hooks/response/")).toBe(true);

    const id = url.split("/").pop()!;
    expect(interactions.getResponseCtx(id)).toEqual({ channel: "C01GEN", user: "U01ALICE" });
  });

  test("getResponseCtx returns undefined for an unknown id", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    expect(interactions.getResponseCtx("unknown")).toBeUndefined();
  });
});

describe("Interactions — instantiateView", () => {
  test("stamps id/team/app/bot metadata onto the raw view", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const view = interactions.instantiateView({ type: "modal", title: { text: "Hi" } });
    expect(view.id).toMatch(/^V/);
    expect(view.team_id).toBe("T01TEST");
    expect(view.app_id).toBe("A01APP");
    expect(view.bot_id).toBe("B0BOT");
    expect(view.state).toEqual({ values: {} });
  });
});

describe("Interactions — buildBlockActions", () => {
  test("produces a block_actions payload with a fresh trigger_id and response_url", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const message = { ts: "1.000001", channel: "C01GEN", text: "hi" };
    const payload = interactions.buildBlockActions({
      user: "U01ALICE",
      channel: "C01GEN",
      message,
      action: { type: "button", action_id: "do_click", block_id: "b1", value: "clicked" },
    });

    expect(payload.type).toBe("block_actions");
    expect(payload.user.id).toBe("U01ALICE");
    expect(payload.user.name).toBe("alice");
    expect(payload.channel.id).toBe("C01GEN");
    expect(payload.channel.name).toBe("general");
    expect(payload.trigger_id).toBeTruthy();
    expect(payload.response_url).toContain("/_hooks/response/");
    expect(payload.actions[0]).toMatchObject({
      action_id: "do_click",
      block_id: "b1",
      value: "clicked",
      type: "button",
    });
  });
});

describe("Interactions — buildViewSubmission", () => {
  test("fills untouched input blocks with an empty value so bots reading state.values don't crash", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const view = {
      id: "V1",
      blocks: [
        {
          type: "input",
          block_id: "name_block",
          element: { type: "plain_text_input", action_id: "name" },
        },
        {
          type: "input",
          block_id: "color_block",
          element: { type: "static_select", action_id: "color" },
        },
      ],
    };

    // The user only filled in the text input; the select was never touched.
    const payload = interactions.buildViewSubmission({
      user: "U01ALICE",
      view,
      values: { name_block: { name: { type: "plain_text_input", value: "Alice" } } },
    });

    expect(payload.type).toBe("view_submission");
    expect(payload.view.state.values.name_block.name).toEqual({
      type: "plain_text_input",
      value: "Alice",
    });
    // Untouched select still appears, with a null selection rather than being absent.
    expect(payload.view.state.values.color_block.color).toEqual({
      type: "static_select",
      selected_option: null,
    });
  });

  test("omits non-input blocks from state.values", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const view = {
      id: "V1",
      blocks: [
        { type: "section", block_id: "s1", text: { type: "mrkdwn", text: "hi" } },
        { type: "input", block_id: "b1", element: { type: "plain_text_input", action_id: "a1" } },
      ],
    };
    const payload = interactions.buildViewSubmission({ user: "U01ALICE", view, values: {} });
    expect(Object.keys(payload.view.state.values)).toEqual(["b1"]);
  });
});

describe("Interactions — buildSlashCommand / buildViewClosed", () => {
  test("buildSlashCommand fills in channel/user names and issues trigger_id + response_url", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const payload = interactions.buildSlashCommand({
      user: "U02BOB",
      channel: "C01GEN",
      command: "/echo",
      text: "hello",
    });
    expect(payload.user_id).toBe("U02BOB");
    expect(payload.user_name).toBe("bob");
    expect(payload.channel_name).toBe("general");
    expect(payload.command).toBe("/echo");
    expect(payload.text).toBe("hello");
    expect(payload.trigger_id).toBeTruthy();
    expect(payload.response_url).toContain("/_hooks/response/");
  });

  test("buildViewClosed carries the view and user through", () => {
    const store = makeStore();
    const interactions = new Interactions(store);
    const view = { id: "V1", type: "modal" };
    const payload = interactions.buildViewClosed({ user: "U01ALICE", view });
    expect(payload.type).toBe("view_closed");
    expect(payload.view).toBe(view);
    expect(payload.user.id).toBe("U01ALICE");
  });
});
