import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const version = process.env.RELEASE_VERSION?.replace(/^v/, "");
const privateKeyPem = process.env.RELEASE_PRIVATE_KEY_FILE
  ? await readFile(process.env.RELEASE_PRIVATE_KEY_FILE, "utf8")
  : process.env.RELEASE_PRIVATE_KEY_PEM;
const publicKeyPem = process.env.RELEASE_PUBLIC_KEY_FILE
  ? await readFile(process.env.RELEASE_PUBLIC_KEY_FILE, "utf8")
  : process.env.RELEASE_PUBLIC_KEY_PEM;
if (!version || !privateKeyPem || !publicKeyPem) throw new Error("RELEASE_VERSION and release key variables are required");
const directory = resolve("release");
const files = (await readdir(directory)).filter((file) => file.startsWith("ziloteams-") && !file.endsWith(".sig"));
const artifacts = {};
for (const file of files) {
  const bytes = await readFile(resolve(directory, file));
  const fileStat = await stat(resolve(directory, file));
  const target = file.slice("ziloteams-".length);
  artifacts[target] = {
    url: `https://teams.zilobase.com/releases/v${version}/${file}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: fileStat.size
  };
}
const manifest = Buffer.from(`${JSON.stringify({ version, publishedAt: new Date().toISOString(), artifacts }, null, 2)}\n`);
await writeFile(resolve(directory, "latest.json"), manifest);
await writeFile(resolve(directory, "latest.json.sig"), sign("sha256", manifest, createPrivateKey(privateKeyPem)));

const envLines = [`version ${version}`];
for (const [target, artifact] of Object.entries(artifacts)) {
  envLines.push(`${target}-url ${artifact.url}`, `${target}-sha256 ${artifact.sha256}`, `${target}-size ${artifact.size}`);
}
const envManifest = Buffer.from(`${envLines.join("\n")}\n`);
await writeFile(resolve(directory, "latest.env"), envManifest);
await writeFile(resolve(directory, "latest.env.sig"), sign("sha256", envManifest, createPrivateKey(privateKeyPem)));

const installerTemplate = await readFile("scripts/install.sh.template", "utf8");
await writeFile(
  resolve(directory, "install.sh"),
  installerTemplate.replace("__RELEASE_PUBLIC_KEY_B64__", Buffer.from(publicKeyPem).toString("base64")),
  { mode: 0o755 }
);
