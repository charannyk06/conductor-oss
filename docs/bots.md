# Teammate bots

A bot is a named, persistent teammate built on a project dispatcher. You give it a name, a
role, and standing instructions, then message it. It plans work in one project and hands tasks
to coding agents on this machine. Everything stays local: bots, routines, and push
subscriptions are stored under `.conductor/rust-backend/` in your workspace.

Open the dashboard and choose **Bots** in the top bar, or go to `/bots`.

## What a bot has

| Part | What it does |
|------|--------------|
| Name, emoji, role | Identity shown in the list and used in replies. |
| Standing instructions | Appended to every turn the bot runs, however the turn was started. |
| Project | The repository the bot works in. One bot, one project. |
| Planner and handoff agents | Which agent runs the bot's own conversation and which does the coding. |
| Mention handles | Names the bot answers to in GitHub comments and Slack. The slug of its name always works. |
| Default bot | Receives requests that address Conductor without naming a bot. |

Each bot owns one conversation. **New conversation** starts a fresh one; the old thread stays
in the project's dispatcher history. Changing a bot's project or agents also starts a fresh
conversation on the next message.

## Inbox

**Inbox** lists everything waiting on you across all projects:

- plans a bot or dispatcher wants approved,
- coding sessions waiting for input,
- sessions and bot turns that failed in the last 24 hours.

## Routines

A routine messages a bot on a schedule: every N minutes (5 or more), daily at a time, or weekly
on chosen days. Routines run only while Conductor is running on this machine. Times use the
UTC offset of the browser that saved the routine, so they do not follow daylight-saving
changes; re-save a routine after a clock change.

If the bot is busy when a routine is due, the routine retries two minutes later rather than
interrupting the turn.

## Notifications on your phone

The dashboard is installable (Add to Home Screen) and can send Web Push notifications when
something new lands in the inbox.

1. Open `/bots` on the device over HTTPS (or `localhost`) and choose **Notifications → Enable**.
2. On iOS, install the dashboard to the Home Screen first; Safari only allows push for installed apps.

The backend talks to the browser vendor's push service directly using a VAPID key it generates
on first use. Set `CONDUCTOR_PUSH_CONTACT` to a `mailto:` or `https://` address if you want push
services to have a contact for this install.

## GitHub mentions

Mention a bot in an issue or pull request comment and it answers in the same thread:

```
@triage is this a duplicate of #41?
@conductor summarise what changed in this PR
```

Requirements:

- The existing GitHub webhook is configured (`CONDUCTOR_GITHUB_WEBHOOK_SECRET`) and delivers
  **Issue comments** to `/api/github/webhook`.
- The bot's project has `repo` set to the repository the comment is on.
- `gh` is authenticated on this machine; replies are posted with `gh issue comment`, so they
  appear under your GitHub account, prefixed with the bot's name.

Only comments from the repository's owner, members, and collaborators are acted on. `@conductor`
goes to the default bot among the bots for that repository.

## Slack

1. Create a Slack app with the **Events API** enabled and the request URL
   `https://<your dashboard>/api/slack/events`.
2. Subscribe to the bot events `app_mention` and `message.im`, and grant the scopes
   `app_mentions:read`, `im:history`, and `chat:write`.
3. Start Conductor with:
   - `CONDUCTOR_SLACK_SIGNING_SECRET` – the app's signing secret (required; requests without a
     valid signature are rejected),
   - `CONDUCTOR_SLACK_BOT_TOKEN` – the bot token used to post replies,
   - `CONDUCTOR_SLACK_ALLOWED_USERS` – optional comma-separated Slack user ids allowed to
     trigger bots. Without it, anyone who can mention the app in your workspace can.

Mention the app, or message it directly. To pick one of several bots, start with its handle:
`@Conductor triage: what broke overnight?`. Otherwise the message goes to the bot bound to that
channel (set **Slack channel IDs** on the bot), then to the default bot. The reply is posted in
a thread under your message.

## MCP servers

**Settings → MCP Servers** manages the tool servers agents and bots are launched with, globally
or per project. Only admins can view or change them. Environment values are stored in
`conductor.yaml` and shown masked in the dashboard.

## Security notes

- A bot runs agents on your machine with your permissions. Treat mention handles and Slack
  access like shell access: keep the Slack allowlist tight and do not expose the webhook
  endpoints without their signing secrets.
- Text arriving from GitHub or Slack is passed to the agent as a request. The bot is told to
  treat quoted third-party content as untrusted, but that is guidance to a model, not a sandbox.
