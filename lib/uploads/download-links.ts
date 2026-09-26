import { createHmac,timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { accessOwner,type AccessOwner } from "../agent-access/contract";
import { AppError } from "../http/errors";
import { uploadId } from "./schema";
import { UPLOAD_DOWNLOAD_LINK_TTL_MS,uploadDownloadGrant,uploadDownloadLink } from "./download-link-contract";

const keyId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const settings = z.object({ audience: z.string().min(1).max(200),activeKey: keyId,
  keys: z.record(keyId,z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();
type Settings = z.infer<typeof settings>;
export type DownloadGrant = { sha256: string;issuedAt: number;expiresAt: number };
const invalid = () => new AppError(403,"download_link_invalid","Download link is invalid for this account or file.");

export function uploadLinkSettings(env: Record<string,string | undefined> = process.env): Settings | null {
  if (!env.UPLOAD_DOWNLOAD_SIGNING_JSON) return null;
  try {
    const value = settings.parse(JSON.parse(env.UPLOAD_DOWNLOAD_SIGNING_JSON));
    if (!Object.hasOwn(value.keys,value.activeKey) || Object.keys(value.keys).length > 5) throw new Error();
    return value;
  } catch { throw new AppError(503,"download_links_unconfigured","Configure the server-only upload download signing keyring."); }
}
function configured(env: Record<string,string | undefined>) {
  const value = uploadLinkSettings(env);
  if (!value) throw new AppError(503,"download_links_disabled","Short-lived upload download links are not enabled on this host.");
  return value;
}
function digest(owner: AccessOwner,id: string,sha256: string,issuedAt: number,kid: string,config: Settings) {
  const message = JSON.stringify(["jumpstart-upload-download-v1",config.audience,"GET",`/api/v1/uploads/${id}/download`,
    owner.tenant,owner.subject,sha256,issuedAt,kid]);
  return createHmac("sha256",Buffer.from(config.keys[kid],"hex")).update(message).digest();
}
export function assertDownloadGrantLive(grant: DownloadGrant,now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < grant.issuedAt - 5000 || now >= grant.expiresAt) {
    throw new AppError(410,"download_link_expired","Download link expired. Request a new link.");
  }
}

/** A link adds a time/content fence; a current owner credential is still required. */
export function signUploadDownload(owner: AccessOwner,rawId: string,sha256: string,
  env: Record<string,string | undefined> = process.env,now = Date.now()) {
  const config = configured(env),checked = accessOwner.parse(owner),id = uploadId.parse(rawId);
  z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - UPLOAD_DOWNLOAD_LINK_TTL_MS).parse(now);
  const signature = digest(checked,id,sha256,now,config.activeKey,config).toString("base64url");
  const grant = `v1.${config.activeKey}.${now}.${sha256}.${signature}`;
  return uploadDownloadLink.parse({ url: `/api/v1/uploads/${id}/download?grant=${grant}`,expiresAt: now + UPLOAD_DOWNLOAD_LINK_TTL_MS });
}
export function verifyUploadDownload(owner: AccessOwner,rawId: string,rawGrant: string,
  env: Record<string,string | undefined> = process.env,now = Date.now()): DownloadGrant {
  const checked = uploadDownloadGrant.safeParse(rawGrant);
  if (!checked.success) throw invalid();
  const config = configured(env),id = uploadId.parse(rawId),[ ,kid,time,sha256,signature ] = checked.data.split(".");
  const issuedAt = Number(time);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > Number.MAX_SAFE_INTEGER - UPLOAD_DOWNLOAD_LINK_TTL_MS ||
      String(issuedAt) !== time || !Object.hasOwn(config.keys,kid)) throw invalid();
  const expected = digest(accessOwner.parse(owner),id,sha256,issuedAt,kid,config),actual = Buffer.from(signature,"base64url");
  if (actual.length !== expected.length || actual.toString("base64url") !== signature || !timingSafeEqual(expected,actual)) throw invalid();
  const grant = { sha256,issuedAt,expiresAt: issuedAt + UPLOAD_DOWNLOAD_LINK_TTL_MS };
  assertDownloadGrantLive(grant,now);
  return grant;
}
