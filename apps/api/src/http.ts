import { isPlainObject } from "@ziloteams/contracts";
import { ApiError } from "./errors.js";

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "A valid JSON object is required");
  }
  if (!isPlainObject(value)) throw new ApiError(400, "invalid_body", "A JSON object is required");
  return value;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function setRequestIdHeader(response: Response, requestId: string): void {
  // A WebSocket upgrade response has immutable headers in the Workers runtime.
  if (response.status !== 101) response.headers.set("x-request-id", requestId);
}

export function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}
