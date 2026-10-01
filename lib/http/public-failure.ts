// Shared public machine codes. Unknown/proxy values never become log text.
const codes = new Set([
  "active_limit", "daily_limit", "rate_limit",
  "request_limit", "request_limit_unavailable",
  "artifact_not_found", "artifact_conflict", "artifact_version_limit", "auth_unconfigured", "body_too_large", "cancellation_reconciliation_required",
  "chat_disabled", "chat_unconfigured", "configuration_error", "confirmation_failed",
  "conversation_already_started", "conversation_changed", "conversation_not_found", "creation_conflict",
  "creation_unavailable", "download_link_expired", "download_link_invalid", "download_links_disabled",
  "download_links_unconfigured", "forbidden", "identity_unavailable", "internal_error", "invalid_input",
  "invalid_json", "invalid_upload", "not_found", "origin_rejected", "preferences_changed",
  "projection_recovery_failed", "projection_unavailable", "record_deleted", "request_failed",
  "scanner_unavailable", "source_events_unavailable", "storage_contract_error", "storage_unavailable",
  "unauthorized", "unsupported_media_type", "upload_busy", "upload_review_conflict", "upload_review_required", "upload_extraction_unsupported", "upload_extraction_too_large", "upload_conflict", "upload_download_busy", "upload_scan_busy",
  "upload_download_disabled", "upload_integrity_failed", "upload_quota", "upload_rejected",
  "upload_storage_unavailable", "write_conflict",
]);
export function publicErrorCode(value: unknown, fallback: "request_failed" | "internal_error" = "request_failed"): string {
  return typeof value === "string" && codes.has(value) ? value : fallback;
}
export function publicRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : undefined;
}

/** Bounded error-only decoding; never echo a proxy page, provider message or body. */
export async function readPublicFailure(response: Response): Promise<{ code: string; requestId?: string }> {
  const headerId = publicRequestId(response.headers.get("x-request-id"));
  const fallback = { code: "request_failed", ...(headerId ? { requestId: headerId } : {}) };
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => {});
    return fallback;
  }
  const reader = response.body?.getReader();
  if (!reader) return fallback;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) return fallback;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const error = data && typeof data === "object" && "error" in data ? data.error : undefined;
    if (!error || typeof error !== "object" || !("code" in error)) return fallback;
    const bodyId = "requestId" in error ? publicRequestId(error.requestId) : undefined;
    // A proxy replacing either identifier must not falsely correlate two requests.
    const requestId = headerId && bodyId && headerId !== bodyId ? undefined : headerId ?? bodyId;
    return { code: publicErrorCode(error.code), ...(requestId ? { requestId } : {}) };
  } catch { return fallback; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
