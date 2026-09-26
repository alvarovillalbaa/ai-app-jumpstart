import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { AppError } from "./errors";
import { config } from "../config";

export async function readJson(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AppError(415, "unsupported_media_type", "Use application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "invalid_json", "A JSON body is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) { await reader.cancel(); throw new AppError(413, "body_too_large", "Request body exceeds 128 KiB."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new AppError(400, "invalid_json", "Invalid JSON body."); }
}

export function validateOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(config().APP_ORIGIN).origin) throw new AppError(403, "origin_rejected", "Request origin is not allowed.");
}

export async function handle(request: Request, operation: () => Promise<Response>) {
  const requestId = randomUUID();
  const start = Date.now();
  let response: Response;
  try { validateOrigin(request); response = await operation(); }
  catch (error) {
    const known = error instanceof AppError;
    const status = known ? error.status : error instanceof ZodError ? 400 : 500;
    response = Response.json({ error: {
      code: known ? error.code : status === 400 ? "invalid_input" : "internal_error",
      message: known ? error.message : status === 400 ? "Input does not match the contract." : "The request could not be completed.",
      requestId,
    } }, { status, headers: status === 401 ? { "www-authenticate": 'Bearer realm="app"' } : {} });
  }
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-request-id", requestId);
  response.headers.set("x-content-type-options", "nosniff");
  // Deliberately exclude URL/query, prompts, input bodies, identities and credentials.
  console.info(JSON.stringify({ event: "http_request", requestId, method: request.method, status: response.status, durationMs: Date.now() - start }));
  return response;
}
