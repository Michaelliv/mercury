import type { Db } from "../storage/db.js";
import type { Conversation } from "../types.js";

export interface ConversationResolution {
  conversation: Conversation;
  spaceId: string;
}

export function resolveConversation(
  db: Db,
  platform: string,
  externalId: string,
  kind: string,
  observedTitle?: string,
): ConversationResolution | null {
  const conversation = db.ensureConversation(
    platform,
    externalId,
    kind,
    observedTitle,
  );

  if (!conversation.spaceId) return null;

  return { conversation, spaceId: conversation.spaceId };
}

export function inferConversationKind(
  platform: string,
  externalId: string,
  isDM: boolean,
): string {
  if (isDM) return "dm";

  switch (platform) {
    case "whatsapp":
      return "group";
    case "discord":
      return externalId.includes(":") ? "thread" : "channel";
    case "slack":
      return "channel";
    case "teams":
      return "channel";
    default:
      return "group";
  }
}
