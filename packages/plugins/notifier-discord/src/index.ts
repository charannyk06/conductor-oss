/**
 * notifier-discord plugin — Discord notifications via REST API.
 *
 * Uses direct fetch() calls to the Discord REST API.
 * Bot token from env var DISCORD_BOT_TOKEN.
 * Channel ID must be provided via plugin config.
 */

import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  EventType,
  EventPriority,
} from "@conductor-oss/core";

export const manifest = {
  name: "discord",
  slot: "notifier" as const,
  description: "Notifier plugin: Discord via REST API",
  version: "0.2.3",
};

// ---------------------------------------------------------------------------
// Discord API Types
// ---------------------------------------------------------------------------

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
  footer?: { text: string };
}

interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

/** Map event types to emoji prefixes */
function eventEmoji(type: EventType): string {
  if (type.startsWith("session.spawned")) return "🚀";
  if (type.startsWith("session.working")) return "⚙️";
  if (type.startsWith("session.exited")) return "🏁";
  if (type.startsWith("session.killed")) return "💀";
  if (type.startsWith("session.stuck")) return "🪫";
  if (type.startsWith("session.needs_input")) return "⏳";
  if (type.startsWith("session.errored")) return "💥";
  if (type.startsWith("pr.created")) return "📬";
  if (type.startsWith("pr.merged")) return "🎉";
  if (type.startsWith("pr.closed")) return "🚫";
  if (type.startsWith("ci.passing")) return "✅";
  if (type.startsWith("ci.failing")) return "❌";
  if (type.startsWith("ci.fix_sent")) return "🔧";
  if (type.startsWith("review.approved")) return "👍";
  if (type.startsWith("review.changes_requested")) return "📝";
  if (type.startsWith("review.pending")) return "👀";
  if (type.startsWith("merge.ready")) return "🟢";
  if (type.startsWith("merge.completed")) return "🏆";
  if (type.startsWith("merge.conflicts")) return "⚠️";
  if (type.startsWith("reaction.")) return "⚡";
  if (type.startsWith("summary.")) return "📊";
  return "📢";
}

/** Map priority to Discord embed color */
function priorityColor(priority: EventPriority): number {
  switch (priority) {
    case "urgent":
      return 0xff0000; // Red
    case "action":
      return 0xff8c00; // Dark orange
    case "warning":
      return 0xffd700; // Gold
    case "info":
    default:
      return 0x5865f2; // Discord blurple
  }
}

function formatEmbed(event: OrchestratorEvent): DiscordEmbed {
  const emoji = eventEmoji(event.type);
  const fields: DiscordEmbed["fields"] = [];

  fields.push({
    name: "Session",
    value: `\`${event.sessionId}\``,
    inline: true,
  });

  fields.push({
    name: "Project",
    value: `\`${event.projectId}\``,
    inline: true,
  });

  fields.push({
    name: "Event",
    value: `\`${event.type}\``,
    inline: true,
  });

  // Add extra data fields if present
  if (event.data["url"] && typeof event.data["url"] === "string") {
    fields.push({
      name: "URL",
      value: event.data["url"],
      inline: false,
    });
  }

  if (event.data["branch"] && typeof event.data["branch"] === "string") {
    fields.push({
      name: "Branch",
      value: `\`${event.data["branch"]}\``,
      inline: true,
    });
  }

  return {
    title: `${emoji} ${event.type.replace(/\./g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
    description: event.message,
    color: priorityColor(event.priority),
    fields,
    timestamp: event.timestamp.toISOString(),
    footer: { text: `Conductor | ${event.priority}` },
  };
}

// ---------------------------------------------------------------------------
// Discord API Client
// ---------------------------------------------------------------------------

async function sendDiscordMessage(
  channelId: string,
  botToken: string,
  message: DiscordMessage,
): Promise<void> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "unknown error");
    throw new Error(`Discord API error ${response.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Plugin Implementation
// ---------------------------------------------------------------------------

export function create(config?: Record<string, unknown>): Notifier {
  const channelId = config?.channelId as string | undefined;
  const tokenEnvVar = (config?.tokenEnvVar as string) ?? "DISCORD_BOT_TOKEN";

  if (!channelId) {
    console.warn("[notifier-discord] No channelId configured — Discord notifications disabled.");
    console.warn("[notifier-discord] Set plugins.discord.channelId in conductor.yaml");
    return {
      name: "discord",
      async notify(): Promise<void> { /* noop */ },
    };
  }

  return {
    name: "discord",

    async notify(event: OrchestratorEvent): Promise<void> {
      const botToken = process.env[tokenEnvVar];
      if (!botToken) {
        console.warn(`[notifier-discord] ${tokenEnvVar} not set, skipping notification`);
        return;
      }

      try {
        const embed = formatEmbed(event);
        await sendDiscordMessage(channelId, botToken, { embeds: [embed] });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[notifier-discord] Failed to send notification: ${msg}`);
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
