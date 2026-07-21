import type { MembershipRole, Message } from "@ziloteams/contracts";

export interface UiCommand {
  name: string;
  label: string;
  shortcut?: string;
  admin?: boolean;
}

export interface FencedCodeBlock {
  language: string;
  code: string;
}

export const UI_COMMANDS: readonly UiCommand[] = [
  { name: "channels", label: "Browse and switch channels", shortcut: "Ctrl+L" },
  { name: "switch", label: "Switch organization", shortcut: "Ctrl+K" },
  { name: "upload", label: "Upload a file", shortcut: "Ctrl+U" },
  { name: "settings", label: "Profile and workspace settings" },
  { name: "create-channel", label: "Create a channel", admin: true },
  { name: "invite", label: "Invite people", admin: true },
  { name: "delete", label: "Delete a recent message" },
  { name: "help", label: "Keyboard shortcuts" },
  { name: "quit", label: "Quit ZiloTeams" }
];

export type LayoutSize = "compact" | "medium" | "wide";

export function layoutSize(width: number): LayoutSize {
  if (width >= 100) return "wide";
  if (width >= 72) return "medium";
  return "compact";
}

export function colorIndexForUsername(username: string, colorCount: number): number {
  if (!Number.isInteger(colorCount) || colorCount < 1) throw new RangeError("colorCount must be a positive integer");
  let hash = 2_166_136_261;
  for (const character of username.trim().toLowerCase()) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % colorCount;
}

export function parseFencedCode(text: string): FencedCodeBlock | null {
  const match = text.trim().match(/^```([^\n`]*)\n([\s\S]*?)\n?```$/);
  if (!match) return null;
  return { language: match[1]!.trim(), code: match[2]! };
}

export function availableCommands(role: MembershipRole, query = ""): UiCommand[] {
  const normalized = query.trim().replace(/^\//, "").toLowerCase();
  return UI_COMMANDS.filter((command) =>
    (!command.admin || role === "admin")
    && (!normalized || command.name.startsWith(normalized) || command.label.toLowerCase().includes(normalized))
  );
}

export function upsertMessage(messages: readonly Message[], message: Message, limit = 500): Message[] {
  const next = [...messages];
  const index = next.findIndex((item) =>
    item.id === message.id
    || Boolean(message.clientMessageId && item.clientMessageId === message.clientMessageId)
  );
  if (index >= 0) next[index] = message;
  else next.push(message);
  return next.slice(-limit);
}

export function markMessageDeleted(messages: readonly Message[], messageId: string, deletedAt: string): Message[] {
  return messages.map((message) => message.id === messageId
    ? { ...message, text: null, deletedAt }
    : message);
}
