import { describe, expect, it } from "vitest";
import { hmacHex, normalizeInviteCode, randomInviteCode, randomOtp, secureHexEqual } from "./crypto.js";

describe("security token helpers", () => {
  it("creates display-safe invite codes", () => {
    const code = randomInviteCode();
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/);
    expect(normalizeInviteCode(code.toLowerCase())).toHaveLength(16);
  });

  it("creates six-digit OTP values", () => {
    expect(randomOtp()).toMatch(/^\d{6}$/);
  });

  it("signs and compares digests without early string equality", async () => {
    const first = await hmacHex("test-secret", "payload");
    const same = await hmacHex("test-secret", "payload");
    const different = await hmacHex("test-secret", "different");
    expect(await secureHexEqual(first, same)).toBe(true);
    expect(await secureHexEqual(first, different)).toBe(false);
  });
});
