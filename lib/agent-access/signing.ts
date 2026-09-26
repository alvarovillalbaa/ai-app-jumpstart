import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { accessOwner, bodyHash, operationId, type AccessOwner, type SessionAccessStore } from "./contract";
import { structuredRecordRequest, structuredRecordSchema, structuredRecordWire } from "./structured-record";

const headerName = "x-jumpstart-create";
const signatureName = "x-jumpstart-signature";
const ttl = 60_000, skew = 5_000;
const keyId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const settings = z.object({ audience: z.string().min(1).max(200), activeKey: keyId, keys: z.record(keyId, z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
export type SigningSettings = z.infer<typeof settings>;
const claimsSchema = accessOwner.extend({
  version: z.literal(1), keyId, audience: z.string().min(1).max(200),
  method: z.literal("POST"), path: z.literal("/eve/v1/session"),
  operationId, requestHash: bodyHash, issuedAt: z.number().int().positive(), nonce: z.uuid(),
}).strict();
const plainMessage = z.object({ message: z.string().min(1).max(32_000), operationId }).strict();
export const creationInput = z.union([plainMessage,structuredRecordRequest]);
export const createMessage = z.union([plainMessage,structuredRecordWire]);
export function creationBody(input: unknown) {
  const requested = creationInput.parse(input);
  const wire = { message: requested.message,operationId: requested.operationId,
    ...("mode" in requested ? { outputSchema: structuredRecordSchema } : {}) };
  return { requested,body: JSON.stringify(createMessage.parse(wire)) };
}
export const requestHash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
export function checkedSettings(input: SigningSettings) {
  const value = settings.parse(input);
  if (!Object.hasOwn(value.keys, value.activeKey)) throw new Error("The active signing key is missing.");
  return value;
}
function digest(encoded: string, secret: string) { return createHmac("sha256", Buffer.from(secret, "hex")).update(encoded).digest(); }

/** The broker must persist this exact body hash in a reservation before sending. */
export function signCreation(body: string, owner: AccessOwner, input: SigningSettings, now = Date.now()) {
  const config = checkedSettings(input), message = createMessage.parse(JSON.parse(body));
  if (Buffer.byteLength(body) > 131072) throw new Error("Creation body exceeds the limit.");
  const claims = claimsSchema.parse({ ...owner, version: 1, keyId: config.activeKey, audience: config.audience,
    method: "POST", path: "/eve/v1/session", operationId: message.operationId, requestHash: requestHash(body), issuedAt: now, nonce: randomUUID() });
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { [headerName]: encoded, [signatureName]: digest(encoded, config.keys[config.activeKey]).toString("base64url"), "content-type": "application/json" };
}

async function boundedBody(request: Request): Promise<Uint8Array | null> {
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  const deadline = Date.now() + 8000;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Read timeout")), Math.max(1, deadline - Date.now())); }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) return Buffer.concat(chunks);
      size += result.value.byteLength;
      if (size > 131072) return null;
      chunks.push(result.value);
    }
  } catch { return null; }
  finally {
    // This is one branch of a tee. Awaiting cancellation can deadlock until Eve
    // consumes the untouched original request, which happens only after auth.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Invalid/expired/replayed signatures return null; provider failures propagate. */
export async function verifyCreation(request: Request, input: SigningSettings, store: SessionAccessStore, clock = Date.now): Promise<AccessOwner | null> {
  const config = checkedSettings(input), url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/eve/v1/session" || url.search || !request.headers.get("content-type")?.startsWith("application/json")) return null;
  const encoded = request.headers.get(headerName) ?? "", signature = request.headers.get(signatureName) ?? "";
  if (!/^[a-zA-Z0-9_-]{1,4096}$/.test(encoded) || !/^[a-zA-Z0-9_-]{43}$/.test(signature)) return null;
  let claims: z.infer<typeof claimsSchema>;
  try { claims = claimsSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); } catch { return null; }
  if (claims.audience !== config.audience || !Object.hasOwn(config.keys, claims.keyId)) return null;
  const expected = digest(encoded, config.keys[claims.keyId]), actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return null;
  const timely = () => { const now = clock(); return claims.issuedAt <= now + skew && now < claims.issuedAt + ttl; };
  if (!timely()) return null;
  const body = await boundedBody(request);
  if (!body || requestHash(body) !== claims.requestHash) return null;
  try {
    const message = createMessage.parse(JSON.parse(Buffer.from(body).toString("utf8")));
    if (message.operationId !== claims.operationId) return null;
  } catch { return null; }
  const owner = { tenant: claims.tenant, subject: claims.subject };
  const reservation = await store.getOperation(owner, claims.operationId);
  if (reservation?.status !== "starting" || reservation.requestHash !== claims.requestHash || !timely()) return null;
  const now = clock();
  if (now >= claims.issuedAt + ttl) return null;
  const nonceId = requestHash(JSON.stringify([claims.audience, claims.nonce]));
  if (!await store.claimNonce(nonceId, claims.issuedAt + ttl + skew, now)) return null;
  return owner;
}
