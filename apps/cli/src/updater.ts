import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { RELEASE_PUBLIC_KEY_PEM } from "./release-key.js";

interface ReleaseArtifact {
  url: string;
  sha256: string;
  size: number;
}

interface ReleaseManifest {
  version: string;
  publishedAt: string;
  artifacts: Record<string, ReleaseArtifact>;
}

function targetName(): string {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "unsupported";
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "unsupported";
  return `${platform}-${architecture}`;
}

export function verifyManifest(manifest: Uint8Array, signature: Uint8Array, publicKeyPem = RELEASE_PUBLIC_KEY_PEM): boolean {
  if (!publicKeyPem) return false;
  return verify("sha256", manifest, createPublicKey(publicKeyPem), signature);
}

export async function runUpdate(currentVersion: string): Promise<void> {
  if (!RELEASE_PUBLIC_KEY_PEM) throw new Error("This development build has no release verification key");
  if (["node", "node.exe", "bun", "bun.exe"].includes(basename(process.execPath).toLowerCase())) {
    throw new Error("The source checkout cannot self-update; use the compiled ziloteams binary");
  }
  const baseUrl = process.env.ZILOTEAMS_RELEASES_URL ?? "https://teams.zilobase.com/releases";
  const [manifestResponse, signatureResponse] = await Promise.all([
    fetch(`${baseUrl}/latest.json`, { cache: "no-store" }),
    fetch(`${baseUrl}/latest.json.sig`, { cache: "no-store" })
  ]);
  if (!manifestResponse.ok || !signatureResponse.ok) throw new Error("Could not retrieve the signed release manifest");
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const signature = new Uint8Array(await signatureResponse.arrayBuffer());
  if (!verifyManifest(manifestBytes, signature)) throw new Error("Release manifest signature verification failed");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ReleaseManifest;
  if (manifest.version === currentVersion) {
    console.log(`ziloteams ${currentVersion} is already current.`);
    return;
  }
  const artifact = manifest.artifacts[targetName()];
  if (!artifact) throw new Error(`No release is available for ${targetName()}`);
  const response = await fetch(artifact.url, { cache: "no-store" });
  if (!response.ok) throw new Error("Could not download the update");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== artifact.size) throw new Error("Downloaded update size does not match the signed manifest");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) throw new Error("Downloaded update checksum verification failed");

  const temporary = join(tmpdir(), `ziloteams-${process.pid}`);
  await writeFile(temporary, bytes, { mode: 0o755 });
  await chmod(temporary, 0o755);
  const backup = join(dirname(process.execPath), `.ziloteams-${currentVersion}.backup`);
  await rename(process.execPath, backup);
  try {
    await rename(temporary, process.execPath);
  } catch (error) {
    await rename(backup, process.execPath);
    throw error;
  }
  console.log(`Updated ziloteams ${currentVersion} → ${manifest.version}.`);
}
