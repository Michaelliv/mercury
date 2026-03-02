export type MessageRole = "user" | "assistant" | "tool" | "ambient";

/**
 * Media type classification.
 * Generic across platforms — each adapter maps its native types to these.
 */
export type MediaType = "image" | "video" | "audio" | "voice" | "document";

/**
 * Attachment metadata for messages.
 * Platform-agnostic — adapters populate these fields from platform-specific data.
 */
export interface MessageAttachment {
  /** Local file path (relative to group workspace) */
  path: string;
  /** Media type classification */
  type: MediaType;
  /** MIME type (e.g., "image/jpeg", "audio/ogg") */
  mimeType: string;
  /** Original filename if available */
  filename?: string;
  /** File size in bytes */
  sizeBytes?: number;
}

export interface StoredMessage {
  id: number;
  groupId: string;
  role: MessageRole;
  content: string;
  /** Attachments (images, voice notes, documents, etc.) */
  attachments?: MessageAttachment[];
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTask {
  id: number;
  groupId: string;
  cron: string | null; // null for at-tasks
  at: string | null; // ISO 8601 timestamp, null for cron-tasks
  prompt: string;
  active: number;
  silent: number;
  nextRunAt: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Group {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface GroupRole {
  groupId: string;
  platformUserId: string;
  role: string;
  grantedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GroupConfigEntry {
  groupId: string;
  key: string;
  value: string;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type TriggerMatch = "prefix" | "mention" | "always";

export interface TriggerConfig {
  match: TriggerMatch;
  patterns: string[]; // e.g. ["@Mick", "Mick"]
  caseSensitive: boolean;
}

/**
 * Abstraction for sending messages to groups.
 * Implemented by chat-sdk, used by runtime for scheduled task replies.
 */
export interface MessageSender {
  /**
   * Send a text message to a group.
   * @param groupId - The group identifier (encodes platform, e.g., "whatsapp:123@lid:456@lid")
   * @param text - The message text to send
   */
  send(groupId: string, text: string): Promise<void>;
}
