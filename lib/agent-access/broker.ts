import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../http/errors";
import { accessOwner, conversation, sessionId, type AccessOwner, type SessionAccessStore } from "./contract";
import { creationBody, requestHash, signCreation, type SigningSettings } from "./signing";

const accepted = z.object({ ok: z.literal(true), sessionId, status: z.literal("accepted") });
export type CreationResult = { conversationId: string; operationId: string } & (
  { status: "starting"; sessionId: null } | { status: "active"; sessionId: string }
);
export type CreationTransport = (body: string, owner: AccessOwner) => Promise<string>;

/** Fixed server-owned origin. Callers cannot supply a URL, model or runtime identity. */
export function creationTransport(origin: string, signing: SigningSettings, request: typeof fetch = fetch): CreationTransport {
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS runtime origin, or loopback HTTP for local development.");
  const endpoint = new URL("/eve/v1/session", url);
  return async (body, owner) => {
    const response = await request(endpoint, { method: "POST", body, headers: signCreation(body, owner, signing),
      redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (response.status !== 202) throw new Error("Runtime creation was not acknowledged.");
    // Bound the trusted runtime response as well; do not buffer an unlimited stream.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Runtime creation returned no response.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) throw new Error("Runtime creation response exceeded the limit.");
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    return accepted.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).sessionId;
  };
}

/**
 * Durable single-dispatch coordinator. A starting operation is NEVER automatically
 * resent: a crash between reservation and acknowledgment is an ambiguous start.
 * The runtime receipt can bind it; otherwise reconciliation must investigate it.
 */
export class ConversationBroker {
  constructor(private store: SessionAccessStore, private dispatch: CreationTransport) {}

  async create(ownerInput: AccessOwner, input: unknown): Promise<CreationResult> {
    const owner = accessOwner.parse(ownerInput), { requested,body } = creationBody(input),hash = requestHash(body);
    const title = Array.from(requested.message, char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)
      .join("").replace(/\s+/g," ").trim().slice(0,120).toWellFormed() || "New conversation";
    const won = await this.store.reserve({ ...owner, id: randomUUID(), operationId: requested.operationId, requestHash: hash }, title);
    if (won) {
      try { sessionId.parse(await this.dispatch(body, owner)); }
      catch {
        // A timeout/connection error says nothing about whether Eve accepted it.
        // Do not log the body, credentials or the underlying provider exception.
        return this.read(owner, requested.operationId, hash);
      }
      // HTTP acceptance can name a noncanonical candidate. Only the winning
      // runtime's turn-start receipt may install the usable session mapping.
    }
    return this.read(owner, requested.operationId, hash);
  }

  async read(ownerInput: AccessOwner, operationId: string, expectedHash?: string): Promise<CreationResult> {
    const owner = accessOwner.parse(ownerInput);
    const row = await this.store.getOperation(owner, operationId);
    if (!row) throw new AppError(404, "conversation_not_found", "Conversation not found.");
    const value = conversation.parse(row);
    if (expectedHash && value.requestHash !== expectedHash) throw new AppError(409, "creation_conflict", "This operation already belongs to a different request.");
    if (value.status === "revoked") throw new AppError(409, "creation_unavailable", "This conversation cannot be started.");
    const result = { conversationId: value.id, operationId: value.operationId };
    if (value.status === "active" && value.sessionId) return { ...result, status: "active", sessionId: value.sessionId };
    return { ...result, status: "starting", sessionId: null };
  }
}
