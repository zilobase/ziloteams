import { InputValidationError, type ApiErrorBody } from "@ziloteams/contracts";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  const apiError = error instanceof ApiError
    ? error
    : error instanceof InputValidationError
      ? new ApiError(400, "invalid_input", error.message)
      : new ApiError(500, "internal_error", "The request could not be completed");

  if (!(error instanceof ApiError) && !(error instanceof InputValidationError)) {
    console.error(JSON.stringify({
      message: "request_failed",
      requestId,
      error: error instanceof Error ? error.message : String(error)
    }));
  }

  const body: ApiErrorBody = {
    error: { code: apiError.code, message: apiError.message, requestId }
  };
  return Response.json(body, { status: apiError.status });
}

export function assert(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
