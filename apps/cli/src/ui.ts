import type {
  Channel,
  Message,
  MembershipRole,
  Organization,
  PresenceUser
} from "@ziloteams/contracts";
import { terminal } from "./terminal.js";

const term = terminal;

export type UiAction =
  | { type: "send"; text: string }
  | { type: "command"; name: string }
  | { type: "channel"; channelId: string }
  | { type: "attachment"; attachmentId: string };

interface Command {
  name: string;
  label: string;
  admin?: boolean;
}

const COMMANDS: Command[] = [
  { name: "channels", label: "Channels" },
  { name: "switch", label: "Switch organization" },
  { name: "upload", label: "Upload file" },
  { name: "settings", label: "Settings" },
  { name: "invite", label: "Invite people", admin: true },
  { name: "delete", label: "Delete message" },
  { name: "help", label: "Help" },
  { name: "quit", label: "Quit" }
];

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  return value.length <= width ? value.padEnd(width) : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function wrap(value: string, width: number): string[] {
  if (width <= 1) return [""];
  const result: string[] = [];
  for (const rawLine of value.split("\n")) {
    let line = rawLine;
    while (line.length > width) {
      let split = line.lastIndexOf(" ", width);
      if (split <= 0) split = width;
      result.push(line.slice(0, split));
      line = line.slice(split).trimStart();
    }
    result.push(line);
  }
  return result;
}

export class WorkspaceUi {
  private organization?: Organization;
  private channel?: Channel;
  private channels: Channel[] = [];
  private messages: Message[] = [];
  private presence: PresenceUser[] = [];
  private input = "";
  private status = "Starting…";
  private active = false;
  private busy = false;
  private commandIndex = 0;
  private channelRows = new Map<number, string>();
  private attachmentRows = new Map<number, string>();
  private commandRows = new Map<number, string>();
  private actionHandler?: (action: UiAction) => Promise<void>;

  private readonly keyHandler = (...args: unknown[]) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    const data = typeof args[2] === "object" && args[2] !== null ? args[2] as { isCharacter?: boolean } : {};
    void this.handleKey(name, data);
  };

  private readonly mouseHandler = (...args: unknown[]) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    const data = typeof args[1] === "object" && args[1] !== null ? args[1] as { x?: number; y?: number } : {};
    if (name !== "MOUSE_LEFT_BUTTON_PRESSED" || this.busy || !data.y) return;
    const channelId = this.channelRows.get(data.y);
    const attachmentId = this.attachmentRows.get(data.y);
    const command = this.commandRows.get(data.y);
    if (channelId) void this.runAction({ type: "channel", channelId });
    else if (attachmentId) void this.runAction({ type: "attachment", attachmentId });
    else if (command) void this.runAction({ type: "command", name: command });
  };

  setActionHandler(handler: (action: UiAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  setWorkspace(organization: Organization, channel: Channel, channels: Channel[]): void {
    this.organization = organization;
    this.channel = channel;
    this.channels = channels.filter((item) => !item.archived);
    this.render();
  }

  setMessages(messages: Message[]): void {
    this.messages = messages.slice(-500);
    this.render();
  }

  addMessage(message: Message): void {
    const index = this.messages.findIndex((item) => item.id === message.id || (message.clientMessageId && item.clientMessageId === message.clientMessageId));
    if (index >= 0) this.messages[index] = message;
    else this.messages.push(message);
    this.messages = this.messages.slice(-500);
    this.render();
  }

  deleteMessage(messageId: string, deletedAt: string): void {
    const message = this.messages.find((item) => item.id === messageId);
    if (message) {
      message.deletedAt = deletedAt;
      message.text = null;
    }
    this.render();
  }

  setPresence(presence: PresenceUser[]): void {
    this.presence = presence;
    this.render();
  }

  setStatus(status: string): void {
    this.status = status;
    this.render();
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    term.hideCursor(true);
    term.grabInput({ mouse: "button" });
    term.on("key", this.keyHandler);
    term.on("mouse", this.mouseHandler);
    term.on("resize", this.keyHandler);
    this.render();
  }

  suspend(): void {
    if (!this.active) return;
    this.active = false;
    term.off("key", this.keyHandler);
    term.off("mouse", this.mouseHandler);
    term.off("resize", this.keyHandler);
    term.grabInput(false);
    term.showCursor();
    term.clear();
  }

  resume(): void {
    this.start();
  }

  stop(): void {
    this.suspend();
    term.clear();
  }

  private availableCommands(): Command[] {
    const role: MembershipRole = this.organization?.role ?? "member";
    const search = this.input.startsWith("/") ? this.input.slice(1).toLowerCase() : "";
    return COMMANDS.filter((command) => (!command.admin || role === "admin") && (!search || command.name.startsWith(search)));
  }

  private async handleKey(name: string, data: { isCharacter?: boolean }): Promise<void> {
    if (!this.active || this.busy || name === "RESIZE") {
      if (name === "RESIZE") this.render();
      return;
    }
    if (name === "CTRL_C" || name === "ESCAPE") {
      await this.runAction({ type: "command", name: "quit" });
      return;
    }
    if (name === "BACKSPACE") this.input = this.input.slice(0, -1);
    else if (name === "UP" && this.input.startsWith("/")) {
      this.commandIndex = Math.max(0, this.commandIndex - 1);
    } else if (name === "DOWN" && this.input.startsWith("/")) {
      this.commandIndex = Math.min(this.availableCommands().length - 1, this.commandIndex + 1);
    } else if (name === "ENTER") {
      const value = this.input.trim();
      this.input = "";
      if (value.startsWith("/")) {
        const commands = this.availableCommands();
        const exact = commands.find((command) => command.name === value.slice(1).toLowerCase());
        const command = exact ?? commands[this.commandIndex];
        if (command) await this.runAction({ type: "command", name: command.name });
      } else if (value) {
        await this.runAction({ type: "send", text: value });
      }
      this.commandIndex = 0;
    } else if (data.isCharacter && name.length === 1 && this.input.length < 4_000) {
      this.input += name;
    }
    this.render();
  }

  private async runAction(action: UiAction): Promise<void> {
    if (!this.actionHandler) return;
    this.busy = true;
    try {
      await this.actionHandler(action);
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    if (!this.active) return;
    const width = Math.max(term.width, 60);
    const height = Math.max(term.height, 16);
    const leftWidth = width >= 100 ? 24 : 18;
    const rightWidth = width >= 100 ? 24 : 18;
    const centerWidth = width - leftWidth - rightWidth - 2;
    const messageTop = 3;
    const inputRow = height - 1;
    const messageHeight = height - messageTop - 1;
    this.channelRows.clear();
    this.attachmentRows.clear();
    this.commandRows.clear();
    term.clear();

    term.moveTo(1, 1);
    term.write(`\x1b[48;2;30;41;59m\x1b[97m${clip(` ZiloTeams · ${this.organization?.name ?? "No organization"} · #${this.channel?.name ?? ""}`, width)}\x1b[0m`);
    term.moveTo(1, 2);
    term.write(`\x1b[2m${clip(` ${this.status}`, width)}\x1b[0m`);

    term.moveTo(1, messageTop);
    term.write(`\x1b[1m${clip(" Channels", leftWidth)}\x1b[0m`);
    this.channels.slice(0, messageHeight - 1).forEach((channel, index) => {
      const row = messageTop + 1 + index;
      this.channelRows.set(row, channel.id);
      term.moveTo(1, row);
      const marker = channel.id === this.channel?.id ? "›" : " ";
      term.write(channel.id === this.channel?.id ? `\x1b[96m${clip(`${marker} #${channel.name}`, leftWidth)}\x1b[0m` : clip(`${marker} #${channel.name}`, leftWidth));
    });

    const renderedMessages: Array<{ text: string; attachmentId?: string }> = [];
    for (const message of this.messages) {
      if (message.deletedAt) {
        renderedMessages.push({ text: `[deleted] ${message.senderName}` });
        continue;
      }
      const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (message.attachment) {
        renderedMessages.push({ text: `${time} ${message.senderName}: ↗ ${message.attachment.filename} (${Math.ceil(message.attachment.size / 1024)} KiB)`, attachmentId: message.attachment.id });
      } else {
        const prefix = `${time} ${message.senderName}: `;
        const lines = wrap(`${prefix}${message.text ?? ""}`, centerWidth - 2);
        lines.forEach((line) => renderedMessages.push({ text: line }));
      }
    }
    const visible = renderedMessages.slice(-messageHeight);
    visible.forEach((line, index) => {
      const row = messageTop + index;
      term.moveTo(leftWidth + 2, row);
      term.write(clip(line.text, centerWidth));
      if (line.attachmentId) this.attachmentRows.set(row, line.attachmentId);
    });

    const rightX = width - rightWidth + 1;
    term.moveTo(rightX, messageTop);
    term.write(`\x1b[1m${clip(" Channel details", rightWidth)}\x1b[0m`);
    term.moveTo(rightX, messageTop + 1);
    term.write(clip(this.channel?.topic || "No topic", rightWidth));
    term.moveTo(rightX, messageTop + 3);
    term.write(`\x1b[1m${clip(` Active · ${this.presence.length}`, rightWidth)}\x1b[0m`);
    this.presence.slice(0, messageHeight - 5).forEach((user, index) => {
      term.moveTo(rightX, messageTop + 4 + index);
      term.write(`\x1b[92m${clip(` ● ${user.displayName}`, rightWidth)}\x1b[0m`);
    });

    if (this.input.startsWith("/")) {
      const commands = this.availableCommands();
      const startRow = Math.max(3, inputRow - commands.length);
      commands.forEach((command, index) => {
        const row = startRow + index;
        this.commandRows.set(row, command.name);
        term.moveTo(leftWidth + 2, row);
        const content = clip(`/${command.name} — ${command.label}`, centerWidth);
        term.write(index === this.commandIndex ? `\x1b[48;2;51;65;85m\x1b[97m${content}\x1b[0m` : content);
      });
    }

    term.moveTo(1, inputRow);
    term.write(`\x1b[48;2;17;24;39m\x1b[97m${clip(` Message ${this.busy ? "[busy]" : ""}: ${this.input}`, width)}\x1b[0m`);
    term.hideCursor(true);
  }
}
