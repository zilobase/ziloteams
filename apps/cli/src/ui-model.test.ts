import { describe, expect, it } from "vitest";
import type { Message } from "@ziloteams/contracts";
import { availableCommands, colorIndexForUsername, layoutSize, markMessageDeleted, parseFencedCode, upsertMessage } from "./ui-model.js";

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
    expect(availableCommands("member").map((item) => item.name)).not.toContain("create-channel");
    expect(availableCommands("admin", "/inv").map((item) => item.name)).toEqual(["invite"]);
    expect(availableCommands("admin", "/create").map((item) => item.name)).toEqual(["create-channel"]);
  });

  it("selects responsive layouts at stable breakpoints", () => {
    expect(layoutSize(60)).toBe("compact");
    expect(layoutSize(72)).toBe("medium");
    expect(layoutSize(100)).toBe("wide");
  });

  it("assigns username colors deterministically on the client", () => {
    expect(colorIndexForUsername("Taylor", 9)).toBe(colorIndexForUsername("taylor", 9));
    expect(colorIndexForUsername("Taylor", 9)).toBeGreaterThanOrEqual(0);
    expect(colorIndexForUsername("Taylor", 9)).toBeLessThan(9);
  });

  it("recognizes complete fenced code blocks", () => {
    expect(parseFencedCode("```ts\nconst ready = true;\n```"))
      .toEqual({ language: "ts", code: "const ready = true;" });
    expect(parseFencedCode("ordinary message")).toBeNull();
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
