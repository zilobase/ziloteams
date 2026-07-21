/// <reference types="@cloudflare/vitest-pool-workers" />

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ChannelRoom } from "./ChannelRoom.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("ChannelRoom hibernating WebSockets", () => {
  it("persists versioned connection state on the accepted server socket", async () => {
    const stub = env.CHANNELS.getByName(crypto.randomUUID());
    const expiresAt = Date.now() + 60_000;
    const response = await stub.fetch("https://example.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-ziloteams-user-id": "user-1",
        "x-ziloteams-display-name": "Ada",
        "x-ziloteams-channel-id": "channel-1",
        "x-ziloteams-session-expires": String(expiresAt)
      }
    });

    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (!client) throw new Error("Expected a client WebSocket");
    client.accept();
    await runInDurableObject(stub, async (_instance, state) => {
      const sockets = state.getWebSockets("user:user-1");
      expect(sockets).toHaveLength(1);
      const socket = sockets[0];
      if (!socket) throw new Error("Expected an accepted server WebSocket");
      expect(socket.deserializeAttachment()).toEqual({
        version: 1,
        userId: "user-1",
        displayName: "Ada",
        sessionExpiresAt: expiresAt,
        channelId: "channel-1"
      });
    });
    client.close(1000, "Test complete");
  });

  it("upgrades legacy attachments and persists messages before broadcasting", async () => {
    const stub = env.CHANNELS.getByName(crypto.randomUUID());
    const expiresAt = Date.now() + 60_000;
    const response = await stub.fetch("https://example.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-ziloteams-user-id": "user-2",
        "x-ziloteams-display-name": "Grace",
        "x-ziloteams-channel-id": "channel-2",
        "x-ziloteams-session-expires": String(expiresAt)
      }
    });
    const client = response.webSocket;
    if (!client) throw new Error("Expected a client WebSocket");
    client.accept();

    await runInDurableObject(stub, async (instance: ChannelRoom, state) => {
      const socket = state.getWebSockets("user:user-2")[0];
      if (!socket) throw new Error("Expected an accepted server WebSocket");
      socket.serializeAttachment({
        userId: "user-2",
        displayName: "Grace",
        sessionExpiresAt: expiresAt,
        channelId: "channel-2"
      });
      await instance.webSocketMessage(socket, JSON.stringify({
        type: "message.send",
        clientMessageId: "client-1",
        text: "hello"
      }));
      expect(socket.deserializeAttachment()).toMatchObject({ version: 1 });
    });

    await expect(stub.history()).resolves.toMatchObject([
      { clientMessageId: "client-1", text: "hello", senderId: "user-2" }
    ]);
    client.close(1000, "Test complete");
  });
});
