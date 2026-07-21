import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Channel, Message, Organization } from "@ziloteams/contracts";
import { WorkspaceUi, ZiloTeamsView } from "./ui.js";

const organization: Organization = {
  id: "organization-1",
  name: "Zilo Base",
  role: "admin",
  createdAt: "2026-07-21T00:00:00.000Z"
};
const channel: Channel = {
  id: "channel-1",
  organizationId: organization.id,
  name: "general",
  topic: "Company-wide conversation",
  archived: false,
  isDefault: true,
  createdAt: "2026-07-21T00:00:00.000Z"
};
const message: Message = {
  id: "message-1",
  channelId: channel.id,
  senderId: "user-1",
  senderName: "taylor",
  kind: "text",
  text: "hello team",
  attachment: null,
  clientMessageId: null,
  deletedAt: null,
  createdAt: "2026-07-21T08:07:00.000Z"
};

const store = new WorkspaceUi();
const actions: string[] = [];
const sentTexts: string[] = [];
store.setActionHandler(async (action) => {
  actions.push(action.type === "command" ? action.name : action.type);
  if (action.type === "send") sentTexts.push(action.text);
});
store.setWorkspace(organization, channel, [channel]);
store.setMessages([message]);
store.setStatus("Connected");
const { renderer, renderOnce, flush, waitForFrame, captureCharFrame, mockInput, resize } = await testRender(
  <ZiloTeamsView store={store} />,
  { width: 110, height: 30 }
);

try {
  await renderOnce();
  const frame = captureCharFrame();
  if (
    !frame.includes("ZiloTeams")
    || !frame.includes("Zilo Base")
    || !frame.includes("#general")
    || !frame.includes("channels")
    || !frame.includes("taylor: hello team")
    || !frame.includes("/ commands")
    || !frame.includes("1 messages")
    || frame.includes("New channel")
    || frame.includes("Invite people")
    || frame.includes("Settings")
  ) {
    throw new Error("OpenTUI workspace smoke frame is incomplete");
  }

  let promptResult!: Promise<string>;
  await act(async () => {
    promptResult = store.promptText("Display name");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
  await waitForFrame((next) => next.includes("Display name"));
  await act(async () => {
    await mockInput.typeText("Taylor");
    mockInput.pressEnter();
    await flush();
  });
  if (await promptResult !== "Taylor") throw new Error("OpenTUI text dialog did not resolve its input");

  let channelResult!: Promise<string>;
  await act(async () => {
    channelResult = store.choose("Channel", ["#random", "#general  ● active"], "#general  ● active");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
  await waitForFrame((next) => next.includes("#general  ● active"));
  await act(async () => {
    mockInput.pressEnter();
    await flush();
  });
  if (await channelResult !== "#general  ● active") throw new Error("Channel dialog did not preselect the active channel");

  await act(async () => {
    await mockInput.typeText("/inv");
    await flush();
  });
  await waitForFrame((next) => next.includes("Invite people"));
  await act(async () => {
    mockInput.pressEnter();
    await flush();
  });
  if (!actions.includes("invite")) throw new Error("Command palette did not dispatch the invite action");

  await act(async () => {
    await mockInput.pasteBracketedText("const answer = 42;\nconsole.log(answer);\n");
    mockInput.pressEnter();
    await flush();
  });
  if (sentTexts[0] !== "```\nconst answer = 42;\nconsole.log(answer);\n```") {
    throw new Error("Multiline paste was not sent as a fenced code block");
  }

  await act(async () => {
    resize(60, 20);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
  await waitForFrame((next) => !next.includes("CHANNELS"));

  await act(async () => {
    resize(45, 14);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
  await waitForFrame((next) => next.includes("Terminal is too small"));
  console.log("OpenTUI smoke test passed");
} finally {
  await act(async () => { renderer.destroy(); });
}
