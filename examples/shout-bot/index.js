// A second Bolt app, distinct from echo-bot, for exercising local-slack's
// multi-app support: two apps installed in the same mock workspace at once.
const { App } = require("@slack/bolt");

const SLACK_API_URL = process.env.SLACK_API_URL || "http://localhost:3000/api/";
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "xoxb-shoutbot-token";
const APP_TOKEN = process.env.SLACK_APP_TOKEN || "xapp-shoutbot-token";

const app = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  socketMode: true,
  clientOptions: { slackApiUrl: SLACK_API_URL },
});

app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;
  await say(`${(message.text || "").toUpperCase()}!!!`);
});

app.event("app_home_opened", async ({ event, client }) => {
  await client.views.publish({
    user_id: event.user,
    view: {
      type: "home",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Shout Bot Home" } },
        { type: "section", text: { type: "mrkdwn", text: "I SHOUT EVERYTHING YOU SAY." } },
      ],
    },
  });
});

(async () => {
  await app.start(4100);
  console.log(`shout-bot started (api: ${SLACK_API_URL})`);
})();
