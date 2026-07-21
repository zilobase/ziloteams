import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyManifest } from "./updater.js";

describe("signed release manifests", () => {
  it("accepts the matching signature and rejects tampering", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const manifest = Buffer.from('{"version":"2.1.0"}\n');
    const signature = sign("sha256", manifest, privateKey);
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(verifyManifest(manifest, signature, publicPem)).toBe(true);
    expect(verifyManifest(Buffer.from('{"version":"9.9.9"}\n'), signature, publicPem)).toBe(false);
  });
});
