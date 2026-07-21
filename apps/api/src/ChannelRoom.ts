import { DurableObject } from "cloudflare:workers";
import {
  HISTORY_PAGE_SIZE,
  MAX_MESSAGE_LENGTH,
  isPlainObject,
  type Attachment,
  type Message,
  type PresenceUser,
  type ServerWebSocketEvent
} from "@ziloteams/contracts";

interface ConnectionAttachment {
  userId: string;
  displayName: string;
  sessionExpiresAt: number;
  channelId: string;
}

interface MessageRow {
  [key: string]: SqlStorageValue;
  id: string;
  client_message_id: string | null;
  channel_id: string;
  sender_id: string;
  sender_name: string;
  kind: "text" | "attachment";
  text: string | null;
  attachment_json: string | null;
  created_at: number;
  deleted_at: number | null;
}

function parseAttachment(value: string | null): Attachment | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  if (!isPlainObject(parsed)
    || typeof parsed.id !== "string"
    || typeof parsed.organizationId !== "string"
    || typeof parsed.channelId !== "string"
    || typeof parsed.filename !== "string"
    || typeof parsed.mediaType !== "string"
    || typeof parsed.size !== "number"
    || !["pending", "ready", "deleting", "deleted"].includes(String(parsed.status))
    || typeof parsed.createdAt !== "string") return null;
  return {
    id: parsed.id,
    organizationId: parsed.organizationId,
    channelId: parsed.channelId,
    filename: parsed.filename,
    mediaType: parsed.mediaType,
    size: parsed.size,
    status: parsed.status as Attachment["status"],
    createdAt: parsed.createdAt
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    clientMessageId: row.client_message_id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    kind: row.kind,
    text: row.text,
    attachment: parseAttachment(row.attachment_json),
    createdAt: new Date(row.created_at).toISOString(),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString()
  };
}

export class ChannelRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          client_message_id TEXT,
          channel_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('text', 'attachment')),
          text TEXT,
          attachment_json TEXT,
          created_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id_idx
          ON messages(sender_id, client_message_id)
          WHERE client_message_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS messages_created_idx ON messages(created_at DESC);
      `);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const userId = request.headers.get("x-ziloteams-user-id");
    const displayName = request.headers.get("x-ziloteams-display-name");
    const channelId = request.headers.get("x-ziloteams-channel-id");
    const expiresAt = Number(request.headers.get("x-ziloteams-session-expires"));
    if (!userId || !displayName || !channelId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return new Response("Unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectionAttachment = { userId, displayName, sessionExpiresAt: expiresAt, channelId };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);

    const ready: ServerWebSocketEvent = {
      type: "session.ready",
      messages: await this.history(undefined, HISTORY_PAGE_SIZE),
      presence: this.presence()
    };
    server.send(JSON.stringify(ready));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async history(before?: number, limit = HISTORY_PAGE_SIZE): Promise<Message[]> {
    const safeLimit = Math.max(1, Math.min(limit, HISTORY_PAGE_SIZE));
    const rows = before
      ? this.ctx.storage.sql.exec<MessageRow>(
        `SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`, before, safeLimit
      ).toArray()
      : this.ctx.storage.sql.exec<MessageRow>(
        `SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`, safeLimit
      ).toArray();
    return rows.reverse().map(mapMessage);
  }

  async publishAttachment(
    channelId: string,
    senderId: string,
    senderName: string,
    attachment: Attachment
  ): Promise<Message> {
    const now = Date.now();
    const row: MessageRow = {
      id: crypto.randomUUID(),
      client_message_id: null,
      channel_id: channelId,
      sender_id: senderId,
      sender_name: senderName,
      kind: "attachment",
      text: null,
      attachment_json: JSON.stringify(attachment),
      created_at: now,
      deleted_at: null
    };
    this.insertMessage(row);
    const message = mapMessage(row);
    this.broadcast({ type: "message.created", message });
    return message;
  }

  async deleteMessage(messageId: string, actorId: string, isAdmin: boolean): Promise<{ deletedAt: string; attachmentId: string | null }> {
    const row = this.ctx.storage.sql.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", messageId).toArray()[0];
    if (!row) throw new Error("message_not_found");
    if (!isAdmin && row.sender_id !== actorId) throw new Error("message_delete_forbidden");
    if (row.deleted_at !== null) {
      return { deletedAt: new Date(row.deleted_at).toISOString(), attachmentId: parseAttachment(row.attachment_json)?.id ?? null };
    }
    const deletedAt = Date.now();
    this.ctx.storage.sql.exec("UPDATE messages SET deleted_at = ?, text = NULL WHERE id = ?", deletedAt, messageId);
    const event: ServerWebSocketEvent = { type: "message.deleted", messageId, deletedAt: new Date(deletedAt).toISOString() };
    this.broadcast(event);
    return { deletedAt: event.deletedAt, attachmentId: parseAttachment(row.attachment_json)?.id ?? null };
  }

  async disconnectUser(userId: string, reason = "Your organization access changed"): Promise<void> {
    for (const socket of this.ctx.getWebSockets(`user:${userId}`)) {
      const event: ServerWebSocketEvent = { type: "channel.closed", reason };
      socket.send(JSON.stringify(event));
      socket.close(4003, reason.slice(0, 120));
    }
    this.broadcastPresence();
  }

  async purge(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      const event: ServerWebSocketEvent = { type: "channel.closed", reason: "This channel was deleted" };
      socket.send(JSON.stringify(event));
      socket.close(4004, "Channel deleted");
    }
    this.ctx.storage.sql.exec("DELETE FROM messages");
  }

  override async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment || attachment.sessionExpiresAt <= Date.now()) {
      socket.close(4001, "Session expired");
      return;
    }

    try {
      const text = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed) || parsed.type !== "message.send") throw new Error("unsupported_event");
      if (typeof parsed.clientMessageId !== "string" || typeof parsed.text !== "string") throw new Error("invalid_message");
      if (!parsed.clientMessageId || parsed.clientMessageId.length > 100) throw new Error("invalid_message");
      const messageText = parsed.text.trim();
      if (!messageText || messageText.length > MAX_MESSAGE_LENGTH) throw new Error("invalid_message");

      const existing = this.ctx.storage.sql.exec<MessageRow>(
        "SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?", attachment.userId, parsed.clientMessageId
      ).toArray()[0];
      if (existing) {
        socket.send(JSON.stringify({ type: "message.created", message: mapMessage(existing) } satisfies ServerWebSocketEvent));
        return;
      }

      const row: MessageRow = {
        id: crypto.randomUUID(),
        client_message_id: parsed.clientMessageId,
        channel_id: attachment.channelId,
        sender_id: attachment.userId,
        sender_name: attachment.displayName,
        kind: "text",
        text: messageText,
        attachment_json: null,
        created_at: Date.now(),
        deleted_at: null
      };
      this.insertMessage(row);
      this.broadcast({ type: "message.created", message: mapMessage(row) });
    } catch (error) {
      const response: ServerWebSocketEvent = {
        type: "error",
        code: error instanceof Error ? error.message : "invalid_event",
        message: "The message could not be processed"
      };
      socket.send(JSON.stringify(response));
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    if (socket.readyState < WebSocket.CLOSING) socket.close(code, reason);
    this.broadcastPresence();
  }

  override async webSocketError(_socket: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ message: "channel_socket_error", error: error instanceof Error ? error.message : String(error) }));
    this.broadcastPresence();
  }

  private insertMessage(row: MessageRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO messages
       (id, client_message_id, channel_id, sender_id, sender_name, kind, text, attachment_json, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.client_message_id,
      row.channel_id,
      row.sender_id,
      row.sender_name,
      row.kind,
      row.text,
      row.attachment_json,
      row.created_at,
      row.deleted_at
    );
  }

  private presence(): PresenceUser[] {
    const users = new Map<string, PresenceUser>();
    for (const socket of this.ctx.getWebSockets()) {
      const value = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (value && value.sessionExpiresAt > Date.now()) {
        users.set(value.userId, { userId: value.userId, displayName: value.displayName });
      } else {
        socket.close(4001, "Session expired");
      }
    }
    return Array.from(users.values()).sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence.snapshot", users: this.presence() });
  }

  private broadcast(event: ServerWebSocketEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const value = socket.deserializeAttachment() as ConnectionAttachment | null;
        if (!value || value.sessionExpiresAt <= Date.now()) socket.close(4001, "Session expired");
        else socket.send(payload);
      } catch (error) {
        console.warn(JSON.stringify({ message: "channel_broadcast_failed", error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
}
