import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const targets = [
  ["bun-darwin-arm64", "darwin-arm64"],
  ["bun-darwin-x64", "darwin-x64"],
  ["bun-linux-arm64", "linux-arm64"],
  ["bun-linux-x64-baseline", "linux-x64"]
];
const outputDirectory = resolve("release");
await mkdir(outputDirectory, { recursive: true });

for (const [target, name] of targets) {
  const result = await Bun.build({
    entrypoints: [resolve("apps/cli/src/index.ts")],
    minify: true,
    compile: {
      target,
      outfile: resolve(outputDirectory, `ziloteams-${name}`)
    },
    define: {
      "process.env.OPENTUI_LIBC": JSON.stringify("glibc")
    }
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Bun build failed for ${target}`);
  }
}
