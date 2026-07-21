import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { isPlainObject, type ClientWebSocketEvent, type ServerWebSocketEvent } from "@ziloteams/contracts";

export class RealtimeClient extends EventEmitter {
  private socket?: WebSocket;
  private reconnectAttempt = 0;
  private closedByClient = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly url: string,
    private readonly token: string
  ) {
    super();
  }

  connect(): void {
    this.closedByClient = false;
    this.open();
  }

  disconnect(): void {
    this.closedByClient = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Switching channel");
    this.socket = undefined;
  }

  sendMessage(text: string, clientMessageId = crypto.randomUUID()): string {
    const event: ClientWebSocketEvent = { type: "message.send", clientMessageId, text };
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Chat is reconnecting");
    this.socket.send(JSON.stringify(event));
    return clientMessageId;
  }

  private open(): void {
    this.emit("status", this.reconnectAttempt === 0 ? "Connecting…" : `Reconnecting (${this.reconnectAttempt})…`);
    const socket = new WebSocket(this.url, { headers: { authorization: `Bearer ${this.token}` } });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.emit("status", "Connected");
    });
    socket.on("message", (data: RawData) => this.handleMessage(data));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", (code, reason) => {
      this.emit("status", `Disconnected${reason.length ? `: ${reason.toString()}` : ""}`);
      if (!this.closedByClient && code !== 4001 && code !== 4003 && code !== 4004) this.scheduleReconnect();
      if (code === 4001) this.emit("sessionExpired");
      if (code === 4003 || code === 4004) this.emit("accessChanged", reason.toString());
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const base = Math.min(1_000 * (2 ** Math.min(this.reconnectAttempt, 5)), 30_000);
    const jitter = Math.floor(crypto.getRandomValues(new Uint16Array(1))[0]! / 65_535 * 500);
    this.reconnectTimer = setTimeout(() => this.open(), base + jitter);
  }

  private handleMessage(raw: RawData): void {
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!isPlainObject(parsed) || typeof parsed.type !== "string") throw new Error("Invalid WebSocket event");
      this.emit("event", parsed as ServerWebSocketEvent);
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }
}
