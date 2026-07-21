import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = await mkdtemp(join(tmpdir(), "ziloteams-secrets-"));
const secretFile = join(directory, "secrets.json");

try {
  const secret = () => randomBytes(32).toString("hex");
  await writeFile(secretFile, JSON.stringify({
    OTP_HMAC_KEY: secret(),
    INVITE_HMAC_KEY: secret(),
    FILE_SIGNING_KEY: secret()
  }), { encoding: "utf8", mode: 0o600, flag: "wx" });

  await new Promise((resolve, reject) => {
    const child = spawn("npx", [
      "wrangler", "secret", "bulk", secretFile,
      "--config", "apps/api/wrangler.jsonc"
    ], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`wrangler secret bulk exited with code ${code}`)));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
