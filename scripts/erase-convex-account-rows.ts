import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join,resolve } from "node:path";
import { z } from "zod";
import type { AccessOwner } from "../lib/agent-access/contract";
import { accountDataInventory } from "./account-data-inventory.mjs";
import { inspectConvexAccountData } from "./inspect-convex-account-data";

const entries = accountDataInventory.filter(entry => entry.convex &&
  entry.owner !== "global-expiring" && entry.owner !== "closure-control");
const page = z.object({ rows: z.array(z.record(z.string(),z.unknown())).max(10),
  orphans: z.number().int().nonnegative(),scanned: z.number().int().min(0).max(10),
  done: z.boolean(),cursor: z.string().nullable() }).strict();
const deletion = z.object({ removed: z.number().int().min(0).max(10),
  missing: z.number().int().min(0).max(10) }).strict();
const MAX_PAGES = 10_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left],[right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key,item]) => [key,canonical(item)]));
  return value;
}

function rowDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function endpointFor(siteUrl: string,auditSecret: string,erasureSecret: string,execute: boolean) {
  const url = new URL(siteUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)) ||
      auditSecret.length < 32 || auditSecret.length > 512 || execute &&
      (erasureSecret.length < 32 || erasureSecret.length > 512 || erasureSecret === auditSecret))
    throw new Error("Invalid Convex account erasure configuration.");
  return new URL("/app/audit",url);
}

async function archiveIds(path: string,expected: Record<string,number>) {
  const byEntity = new Map(entries.map(entry => [entry.entity,new Map<string,string>()]));
  const handle = await open(join(resolve(path),"rows.ndjson"),fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const reader = createInterface({ input: handle.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        const item = z.object({ type: z.string(),value: z.unknown() }).strict().parse(JSON.parse(line));
        if (item.type !== "row") continue;
        const value = z.object({ entity: z.string(),rowJson: z.string() }).strict().parse(item.value);
        const rows = byEntity.get(value.entity);
        if (!rows) throw new Error("Convex account bundle contains an unclassified row.");
        const parsed = z.object({ _id: z.string().min(1),_creationTime: z.number() }).passthrough().parse(JSON.parse(value.rowJson));
        if (rows.has(parsed._id)) throw new Error("Convex account bundle contains a duplicate row ID.");
        rows.set(parsed._id,rowDigest(parsed));
      }
    } finally { reader.close(); }
  } finally { await handle.close(); }
  if (entries.some(entry => byEntity.get(entry.entity)!.size !== expected[entry.entity]))
    throw new Error("Convex account bundle entity counts differ from its verified archive.");
  return byEntity;
}

/** Require every remaining owner row to be an unchanged member of the verified bundle. */
async function preflight(audit: (payload: Record<string,unknown>) => Promise<unknown>,
  owner: AccessOwner,byEntity: Map<string,Map<string,string>>) {
  let pages = 0,remaining = 0;
  const existingByEntity = new Map<string,string[]>();
  for (const entry of entries) {
    const archived = byEntity.get(entry.entity)!;
    const seen = new Set<string>();
    const existing: string[] = [];
    let cursor: string | null = null;
    do {
      if (++pages > MAX_PAGES) throw new Error("Convex account erasure preflight exceeded its page limit.");
      const result = page.parse(await audit({ operation: "accountRowPage",entity: entry.convex,cursor }));
      if (result.done !== (result.cursor === null) || !result.done && (!result.scanned || result.cursor === cursor) ||
          result.rows.length+result.orphans > result.scanned || result.orphans !== 0)
        throw new Error("Convex account erasure preflight found an invalid page or orphan.");
      for (const row of result.rows) {
        const id = row._id;
        if (typeof id !== "string" || seen.has(id) || archived.get(id) !== rowDigest(row) ||
            entry.owner === "direct" && (row.tenant !== owner.tenant || row.subject !== owner.subject))
          throw new Error("Current Convex account rows differ from the verified bundle.");
        seen.add(id);existing.push(id);remaining++;
      }
      cursor = result.cursor;
    } while (cursor !== null);
    existingByEntity.set(entry.entity,existing);
  }
  return { remaining,existingByEntity };
}

/** Bounded Convex mutations are resumable from the same private bundle after interruption. */
export async function eraseConvexAccountRows(owner: AccessOwner,bundlePath: string,expected: Record<string,number>,
  siteUrl: string,auditSecret: string,erasureSecret: string,execute: boolean,request: typeof fetch = fetch) {
  const endpoint = endpointFor(siteUrl,auditSecret,erasureSecret,execute);
  const byEntity = await archiveIds(bundlePath,expected);
  async function audit(payload: Record<string,unknown>,erase = false) {
    const response = await request(endpoint,{ method: "POST",redirect: "error",signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json","x-jumpstart-audit-key": auditSecret,
        ...(erase ? { "x-jumpstart-erasure-key": erasureSecret } : {}) },
      body: JSON.stringify({ ...payload,...owner }) });
    if (!response.ok) throw new Error("Convex account erasure request failed.");
    return response.json() as Promise<unknown>;
  }
  const fence = z.object({ fenced: z.boolean() }).strict().parse(await audit({ operation: "accountFenceStatus" }));
  if (!fence.fenced) throw new Error("Account rows must be permanently fenced before erasure.");
  const { remaining: remainingBefore,existingByEntity } = await preflight(audit,owner,byEntity);
  if (!execute) return { remainingBefore,deleted: 0 };
  let deleted = 0;
  for (const entry of [...entries].reverse()) {
    const ids = existingByEntity.get(entry.entity)!;
    for (let offset = 0;offset < ids.length;offset += 10) {
      const batch = ids.slice(offset,offset+10);
      const result = deletion.parse(await audit({ operation: "eraseAccountRows",entity: entry.convex,ids: batch },true));
      if (result.removed+result.missing !== batch.length) throw new Error("Convex account erasure returned an invalid batch count.");
      deleted += result.removed;
    }
  }
  const after = await inspectConvexAccountData(siteUrl,auditSecret,owner.tenant,owner.subject,request);
  if (after.ownerRowTotal !== 0 || after.orphanRowTotal !== 0)
    throw new Error("Convex account application rows remain or became unattributable.");
  const retainedFence = z.object({ fenced: z.boolean() }).strict().parse(await audit({ operation: "accountFenceStatus" }));
  if (!retainedFence.fenced) throw new Error("Convex account write fence is no longer present.");
  return { remainingBefore,deleted };
}
