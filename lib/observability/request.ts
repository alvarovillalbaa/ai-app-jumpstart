import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { AppError } from "../http/errors";
import { publicErrorCode } from "../http/public-failure";

const requests = new AsyncLocalStorage<{ requestId: string }>();
/** Only the server generates this identifier; inbound correlation headers are ignored. */
export function withRequestContext<T>(work: (requestId: string) => T): T {
  const requestId = randomUUID();
  return requests.run({ requestId }, () => work(requestId));
}
export function currentRequestId(): string | undefined { return requests.getStore()?.requestId; }

type FailureEvent = "mcp_tool_failed" | "mcp_resource_failed" | "runtime_creation_unacknowledged";
/** Accept no exception message, input, resource URI, identity or caller metadata. */
export function failureDiagnostic(event: FailureEvent, error: unknown) {
  const requestId = currentRequestId() ?? randomUUID();
  const code = error instanceof AppError ? publicErrorCode(error.code)
    : error instanceof ZodError ? "invalid_input" : "internal_error";
  console.info(JSON.stringify({ event, requestId, code }));
  return { code, requestId };
}
