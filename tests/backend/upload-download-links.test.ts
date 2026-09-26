import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { assertDownloadGrantLive,signUploadDownload,uploadLinkSettings,verifyUploadDownload } from "../../lib/uploads/download-links";
import { uploadDownloadLink } from "../../lib/uploads/download-link-contract";

const owner = { tenant: "private-tenant",subject: "private-owner" },id = randomUUID(),sha = "a".repeat(64),now = 100_000;
const settings = { audience: "test:uploads",activeKey: "a",keys: { a: "a".repeat(64) } };
const env = { UPLOAD_DOWNLOAD_SIGNING_JSON: JSON.stringify(settings) };
const grant = (url: string) => new URL(url,"http://localhost").searchParams.get("grant")!;

it("binds a 60-second grant to both owner fields, the resource, digest and deployment audience",() => {
  const link = signUploadDownload(owner,id,sha,env,now),raw = grant(link.url);
  expect(link.expiresAt).toBe(now + 60_000);
  expect(raw).not.toContain(owner.tenant);expect(raw).not.toContain(owner.subject);
  expect(verifyUploadDownload(owner,id,raw,env,now)).toEqual({ sha256: sha,issuedAt: now,expiresAt: link.expiresAt });
  for (const foreign of [{ ...owner,subject: "other" },{ ...owner,tenant: "other" }]) {
    expect(() => verifyUploadDownload(foreign,id,raw,env,now)).toThrow("invalid for this account");
  }
  expect(() => verifyUploadDownload(owner,randomUUID(),raw,env,now)).toThrow("invalid for this account");
  expect(() => verifyUploadDownload(owner,id,raw.replace(sha,"b".repeat(64)),env,now)).toThrow("invalid for this account");
  expect(() => verifyUploadDownload(owner,id,raw,{ UPLOAD_DOWNLOAD_SIGNING_JSON: JSON.stringify({ ...settings,audience: "other" }) },now)).toThrow("invalid for this account");
});

it("rejects the exact expiry boundary, excessive clock skew and a grant that expires during work",() => {
  const link = signUploadDownload(owner,id,sha,env,now),raw = grant(link.url);
  expect(verifyUploadDownload(owner,id,raw,env,link.expiresAt-1).expiresAt).toBe(link.expiresAt);
  expect(() => verifyUploadDownload(owner,id,raw,env,link.expiresAt)).toThrow("expired");
  expect(() => verifyUploadDownload(owner,id,raw,env,now-5001)).toThrow("expired");
  const accepted = verifyUploadDownload(owner,id,raw,env,now);
  expect(() => assertDownloadGrantLive(accepted,link.expiresAt)).toThrow("expired");
});

it("supports key rotation and immediately fences a retired key",() => {
  const old = grant(signUploadDownload(owner,id,sha,env,now).url);
  const rotated = { UPLOAD_DOWNLOAD_SIGNING_JSON: JSON.stringify({ ...settings,activeKey: "b",keys: { ...settings.keys,b: "b".repeat(64) } }) };
  expect(verifyUploadDownload(owner,id,old,rotated,now)).toMatchObject({ sha256: sha });
  const fresh = grant(signUploadDownload(owner,id,sha,rotated,now).url);
  const retired = { UPLOAD_DOWNLOAD_SIGNING_JSON: JSON.stringify({ ...settings,activeKey: "b",keys: { b: "b".repeat(64) } }) };
  expect(() => verifyUploadDownload(owner,id,old,retired,now)).toThrow("invalid for this account");
  expect(verifyUploadDownload(owner,id,fresh,retired,now)).toMatchObject({ sha256: sha });
});

it("fails closed on malformed grants/keyrings without exposing secrets",() => {
  const raw = grant(signUploadDownload(owner,id,sha,env,now).url);
  for (const invalid of ["",raw+".extra",raw.replace("v1.","v2."),raw.replace(".100000.",".0100000."),raw.replace(".a.",".constructor."),"x".repeat(201)]) {
    expect(() => verifyUploadDownload(owner,id,invalid,env,now)).toThrow();
  }
  expect(uploadLinkSettings({})).toBeNull();
  expect(() => signUploadDownload(owner,id,sha,{},now)).toThrow("not enabled");
  for (const malformed of ["{",JSON.stringify({ ...settings,activeKey: "missing" }),JSON.stringify({ ...settings,keys: { a: "private-invalid-secret" } })]) {
    try { uploadLinkSettings({ UPLOAD_DOWNLOAD_SIGNING_JSON: malformed });throw new Error("accepted invalid keyring"); }
    catch (error) { expect(String(error)).toContain("server-only upload");expect(String(error)).not.toContain("private-invalid-secret"); }
  }
});

it("accepts only an exact relative download route before a client sends credentials",() => {
  const link = signUploadDownload(owner,id,sha,env,now);
  for (const url of ["https://evil.example"+link.url,"//evil.example"+link.url,link.url+"#fragment",link.url+"&next=/evil",link.url.replace("/download?","/scan?")]) {
    expect(uploadDownloadLink.safeParse({ ...link,url }).success).toBe(false);
  }
  expect(uploadDownloadLink.safeParse(link).success).toBe(true);
});
