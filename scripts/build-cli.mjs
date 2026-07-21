import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
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
  await new Promise((resolvePromise, reject) => {
    const child = spawn("bun", [
      "build", "apps/cli/src/index.ts", "--compile", `--target=${target}`,
      "--minify", `--outfile=${resolve(outputDirectory, `ziloteams-${name}`)}`
    ], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Bun build failed for ${target}`)));
  });
}
