export const API_VERSION = "v1";
export const DEFAULT_API_BASE_URL = "https://teams.zilobase.com/api/v1";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_LENGTH = 4_000;
export const HISTORY_PAGE_SIZE = 50;

export type MembershipRole = "admin" | "member";
export type AttachmentStatus = "pending" | "ready" | "deleting" | "deleted";
export type MessageKind = "text" | "attachment";

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
  role: MembershipRole;
  createdAt: string;
}

export interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: MembershipRole;
  joinedAt: string;
}

export interface Invite {
  id: string;
  organizationId: string;
  email: string;
  status: "pending" | "redeemed" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
}

export interface InviteCreated extends Invite {
  code: string;
}

export interface Channel {
  id: string;
  organizationId: string;
  name: string;
  topic: string;
  archived: boolean;
  isDefault: boolean;
  createdAt: string;
}

export interface Attachment {
  id: string;
  organizationId: string;
  channelId: string;
  filename: string;
  mediaType: string;
  size: number;
  status: AttachmentStatus;
  createdAt: string;
}

export interface Message {
  id: string;
  clientMessageId: string | null;
  channelId: string;
  senderId: string;
  senderName: string;
  kind: MessageKind;
  text: string | null;
  attachment: Attachment | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface PresenceUser {
  userId: string;
  displayName: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export type ClientWebSocketEvent =
  | { type: "message.send"; clientMessageId: string; text: string };

export type ServerWebSocketEvent =
  | { type: "session.ready"; messages: Message[]; presence: PresenceUser[] }
  | { type: "message.created"; message: Message }
  | { type: "message.deleted"; messageId: string; deletedAt: string }
  | { type: "presence.snapshot"; users: PresenceUser[] }
  | { type: "channel.closed"; reason: string }
  | { type: "error"; code: string; message: string; clientMessageId?: string };

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const normalized = normalizeEmail(value);
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function normalizeChannelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(
  object: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {}
): string {
  const value = object[key];
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw new InputValidationError(`${key} must contain between ${min} and ${max} characters`);
  }
  return value.trim();
}

export function optionalString(
  object: Record<string, unknown>,
  key: string,
  max: number
): string | undefined {
  const value = object[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new InputValidationError(`${key} must be a string no longer than ${max} characters`);
  }
  return value.trim();
}
