import { describe, expect, it, vi } from "vitest";
import { setRequestIdHeader } from "./http.js";

describe("setRequestIdHeader", () => {
  it("does not mutate immutable WebSocket upgrade headers", () => {
    const set = vi.fn(() => {
      throw new Error("Can't modify immutable headers.");
    });
    const response = { status: 101, headers: { set } } as unknown as Response;

    expect(() => setRequestIdHeader(response, "request-id")).not.toThrow();
    expect(set).not.toHaveBeenCalled();
  });

  it("adds the request ID to regular responses", () => {
    const response = new Response(null, { status: 204 });

    setRequestIdHeader(response, "request-id");

    expect(response.headers.get("x-request-id")).toBe("request-id");
  });
});
