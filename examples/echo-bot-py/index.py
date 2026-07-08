"""A Python (slack_bolt) mirror of ../echo-bot/index.js, for exercising local-slack
end to end from a different language/SDK — no local-slack code changes needed, only
a WebClient pointed at the mock via base_url.

Socket Mode only (the JS example already covers the Events/HTTP path); Bolt for
Python's SocketModeHandler accepts an explicit `web_client`, which is the most
reliable way to redirect *both* its auth token (must be the app-level xapp- token)
and its base_url away from real Slack.

Run against local-slack:
    pip install -r requirements.txt
    python index.py
"""

import os

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from slack_sdk import WebClient

SLACK_API_URL = os.environ.get("SLACK_API_URL", "http://localhost:3000/api/")
BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN", "xoxb-test-token")
APP_TOKEN = os.environ.get("SLACK_APP_TOKEN", "xapp-test-token")

app = App(client=WebClient(token=BOT_TOKEN, base_url=SLACK_API_URL))


# Echo any human message. Ignore messages from bots / with subtypes to avoid loops.
@app.message()
def handle_message(message, say):
    if message.get("subtype") or message.get("bot_id"):
        return
    text = message.get("text") or ""

    # Replies inside a thread stay in that thread.
    thread_ts = message.get("thread_ts")
    if thread_ts:
        say(text=f"(in thread) you said: {text}", thread_ts=thread_ts)
        return

    if text.strip() == "button":
        say(
            text="Here is a button",
            blocks=[
                {"type": "section", "text": {"type": "mrkdwn", "text": "Here is a *button*:"}},
                {
                    "type": "actions",
                    "elements": [
                        {
                            "type": "button",
                            "text": {"type": "plain_text", "text": "Click me"},
                            "action_id": "do_click",
                            "value": "clicked",
                        },
                        {
                            "type": "button",
                            "text": {"type": "plain_text", "text": "Open modal"},
                            "action_id": "open_modal",
                            "value": message["channel"],
                        },
                    ],
                },
            ],
        )
        return

    say(f"You said: {text}")


# Interactivity
@app.action("do_click")
def handle_click(ack, say, body):
    ack()
    say(f"<@{body['user']['id']}> clicked the button")


# Open a modal from a button — uses the trigger_id from the action.
@app.action("open_modal")
def handle_open_modal(ack, body, client):
    ack()
    client.views_open(
        trigger_id=body["trigger_id"],
        view={
            "type": "modal",
            "callback_id": "sample_modal",
            "private_metadata": body["actions"][0]["value"],  # channel to report back to
            "title": {"type": "plain_text", "text": "Sample modal"},
            "submit": {"type": "plain_text", "text": "Submit"},
            "close": {"type": "plain_text", "text": "Cancel"},
            "blocks": [
                {
                    "type": "input",
                    "block_id": "name_block",
                    "label": {"type": "plain_text", "text": "Your name"},
                    "element": {
                        "type": "plain_text_input",
                        "action_id": "name",
                        "placeholder": {"type": "plain_text", "text": "Type here"},
                    },
                }
            ],
        },
    )


# Handle the modal submission.
@app.view("sample_modal")
def handle_view_submission(ack, view, body, client):
    name = (view["state"]["values"]["name_block"]["name"].get("value") or "").strip()
    if not name:
        ack(response_action="errors", errors={"name_block": "Please enter a name"})
        return
    ack()
    client.chat_postMessage(
        channel=view["private_metadata"],
        text=f"<@{body['user']['id']}> submitted the modal: *{name}*",
    )


# Slash command
@app.command("/echo")
def handle_echo_command(ack, respond, command):
    ack()
    respond(f"Echo: {command['text']}")


# App Home
@app.event("app_home_opened")
def handle_app_home_opened(event, client):
    user_id = event["user"]
    client.views_publish(
        user_id=user_id,
        view={
            "type": "home",
            "blocks": [
                {"type": "header", "text": {"type": "plain_text", "text": "Echo Bot (Python) Home"}},
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": f"Hi <@{user_id}>! I echo messages (from Python)."},
                },
            ],
        },
    )


if __name__ == "__main__":
    print(f"echo-bot-py starting in socket mode (api: {SLACK_API_URL})")
    handler = SocketModeHandler(
        app,
        APP_TOKEN,
        web_client=WebClient(token=APP_TOKEN, base_url=SLACK_API_URL),
    )
    handler.start()
