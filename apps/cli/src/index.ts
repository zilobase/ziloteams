#!/usr/bin/env node
import { ZiloTeamsApp } from "./app.js";
import { runUpdate } from "./updater.js";
import packageMetadata from "../../../package.json" with { type: "json" };

const VERSION = packageMetadata.version;
const command = process.argv[2];

if (command === "--version" || command === "version") {
  console.log(`ziloteams ${VERSION}`);
  process.exitCode = 0;
} else if (command === "update") {
  await runUpdate(VERSION);
} else if (command === "--help" || command === "help") {
  console.log("Usage: ziloteams [update|version|help]\n\nRun without a command to open the workspace UI.");
} else {
  const app = new ZiloTeamsApp();
  const shutdown = () => { void app.shutdown(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await app.run();
  } catch (error) {
    await app.shutdown();
    if (!(error instanceof Error) || error.name !== "DialogCancelledError") {
      console.error(`ZiloTeams: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
