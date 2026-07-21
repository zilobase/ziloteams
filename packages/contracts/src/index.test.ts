import { describe, expect, it } from "vitest";
import { InputValidationError, isPlainObject, isValidEmail, normalizeChannelName, normalizeEmail, optionalString, requiredString } from "./index.js";

describe("shared contract normalization", () => {
  it("normalizes emails and rejects malformed addresses", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
    expect(isValidEmail("person@example.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });

  it("normalizes channel names", () => {
    expect(normalizeChannelName(" Product & Design ")).toBe("product-design");
  });

  it("validates required strings", () => {
    expect(requiredString({ name: " Zilo " }, "name", { min: 2, max: 10 })).toBe("Zilo");
    expect(() => requiredString({ name: "" }, "name")).toThrow(InputValidationError);
    expect(optionalString({ topic: "  Roadmap  " }, "topic", 20)).toBe("Roadmap");
  });

  it("only accepts plain objects", () => {
    expect(isPlainObject({ value: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });
});
