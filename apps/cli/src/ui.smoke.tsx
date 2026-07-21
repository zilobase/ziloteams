import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Channel, Organization } from "@ziloteams/contracts";
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

const store = new WorkspaceUi();
const actions: string[] = [];
store.setActionHandler(async (action) => { actions.push(action.type === "command" ? action.name : action.type); });
store.setWorkspace(organization, channel, [channel]);
store.setStatus("Connected");
const { renderer, renderOnce, flush, waitForFrame, captureCharFrame, mockInput, resize } = await testRender(
  <ZiloTeamsView store={store} />,
  { width: 110, height: 30 }
);

try {
  await renderOnce();
  const frame = captureCharFrame();
  if (!frame.includes("ZiloTeams") || !frame.includes("#general") || !frame.includes("CHANNELS")) {
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

  await act(async () => {
    await mockInput.typeText("/inv");
    await flush();
  });
  if (!captureCharFrame().includes("Invite people")) throw new Error("Admin command palette did not open");
  await act(async () => {
    mockInput.pressEnter();
    await flush();
  });
  if (!actions.includes("invite")) throw new Error("Command palette did not dispatch the invite action");

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
