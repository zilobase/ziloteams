import { randomBytes } from "node:crypto";
import { access, chmod, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const path = "apps/api/.dev.vars";

try {
  await access(path, constants.F_OK);
  console.log(`${path} already exists; left unchanged.`);
} catch {
  const secret = () => randomBytes(32).toString("hex");
  const contents = [
    `OTP_HMAC_KEY=${secret()}`,
    `INVITE_HMAC_KEY=${secret()}`,
    `FILE_SIGNING_KEY=${secret()}`,
    ""
  ].join("\n");
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  console.log(`Created ${path} with development-only secrets.`);
}
