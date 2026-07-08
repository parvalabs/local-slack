// A tiny Slack Bolt app for exercising local-slack end to end.
// It connects to the mock instead of real Slack purely via configuration
// (clientOptions.slackApiUrl + the fake tokens), with no other code changes.
//
// Run against local-slack:
//   Socket Mode:  SLACK_MODE=socket node index.js
//   Events (HTTP): SLACK_MODE=events node index.js
const { App } = require("@slack/bolt");

const MODE = process.env.SLACK_MODE || "socket";
const SLACK_API_URL = process.env.SLACK_API_URL || "http://localhost:3000/api/";
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "xoxb-test-token";
const APP_TOKEN = process.env.SLACK_APP_TOKEN || "xapp-test-token";
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "test-signing-secret";
const PORT = Number(process.env.PORT || 4000);

const common = { clientOptions: { slackApiUrl: SLACK_API_URL } };

const app =
  MODE === "socket"
    ? new App({ token: BOT_TOKEN, appToken: APP_TOKEN, socketMode: true, ...common })
    : new App({ token: BOT_TOKEN, signingSecret: SIGNING_SECRET, ...common });

// Echo any human message. Ignore messages from bots / with subtypes to avoid loops.
app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;
  const text = message.text || "";

  // Replies inside a thread stay in that thread.
  if (message.thread_ts) {
    await say({ text: `(in thread) you said: ${text}`, thread_ts: message.thread_ts });
    return;
  }

  if (text.trim() === "button") {
    await say({
      text: "Here is a button",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "Here is a *button*:" } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Click me" },
              action_id: "do_click",
              value: "clicked",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Open modal" },
              action_id: "open_modal",
              value: message.channel,
            },
          ],
        },
      ],
    });
    return;
  }

  await say(`You said: ${text}`);
});

// Interactivity (M2)
app.action("do_click", async ({ ack, say, body }) => {
  await ack();
  await say(`<@${body.user.id}> clicked the button`);
});

// Open a modal from a button — uses the trigger_id from the action.
app.action("open_modal", async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "sample_modal",
      private_metadata: body.actions[0].value, // channel to report back to
      title: { type: "plain_text", text: "Sample modal" },
      submit: { type: "plain_text", text: "Submit" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "name_block",
          label: { type: "plain_text", text: "Your name" },
          element: {
            type: "plain_text_input",
            action_id: "name",
            placeholder: { type: "plain_text", text: "Type here" },
          },
        },
      ],
    },
  });
});

// Handle the modal submission.
app.view("sample_modal", async ({ ack, view, body, client }) => {
  const name = view.state.values.name_block.name.value || "";
  if (!name.trim()) {
    await ack({ response_action: "errors", errors: { name_block: "Please enter a name" } });
    return;
  }
  await ack();
  await client.chat.postMessage({
    channel: view.private_metadata,
    text: `<@${body.user.id}> submitted the modal: *${name}*`,
  });
});

// Slash command (M3)
app.command("/echo", async ({ ack, respond, command }) => {
  await ack();
  await respond(`Echo: ${command.text}`);
});

// App Home (M3)
app.event("app_home_opened", async ({ event, client }) => {
  await client.views.publish({
    user_id: event.user,
    view: {
      type: "home",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Echo Bot Home" } },
        { type: "section", text: { type: "mrkdwn", text: "Hi <@" + event.user + ">! I echo messages." } },
      ],
    },
  });
});

(async () => {
  await app.start(PORT);
  console.log(`echo-bot started in ${MODE} mode (api: ${SLACK_API_URL})`);
})();
