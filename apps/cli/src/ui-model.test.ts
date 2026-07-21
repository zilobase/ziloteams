import { describe, expect, it } from "vitest";
import type { Message } from "@ziloteams/contracts";
import { availableCommands, layoutSize, markMessageDeleted, upsertMessage } from "./ui-model.js";

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "message-1",
  clientMessageId: "client-1",
  channelId: "channel-1",
  senderId: "user-1",
  senderName: "Alex",
  kind: "text",
  text: "Hello",
  attachment: null,
  createdAt: "2026-07-21T00:00:00.000Z",
  deletedAt: null,
  ...overrides
});

describe("OpenTUI view model", () => {
  it("keeps admin commands out of member palettes", () => {
    expect(availableCommands("member").map((item) => item.name)).not.toContain("invite");
    expect(availableCommands("admin", "/inv").map((item) => item.name)).toEqual(["invite"]);
  });

  it("selects responsive layouts at stable breakpoints", () => {
    expect(layoutSize(60)).toBe("compact");
    expect(layoutSize(72)).toBe("medium");
    expect(layoutSize(100)).toBe("wide");
  });

  it("replaces optimistic messages by client ID", () => {
    const optimistic = message({ id: "pending:client-1" });
    const delivered = message({ id: "server-1" });
    expect(upsertMessage([optimistic], delivered)).toEqual([delivered]);
  });

  it("marks deletions without mutating existing state", () => {
    const original = message();
    const next = markMessageDeleted([original], original.id, "2026-07-21T01:00:00.000Z");
    expect(next[0]).toMatchObject({ text: null, deletedAt: "2026-07-21T01:00:00.000Z" });
    expect(original.deletedAt).toBeNull();
  });
});
