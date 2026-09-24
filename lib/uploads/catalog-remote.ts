import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { z } from "zod";
import { ConvexBackend } from "../data/convex-client";
import type { Database } from "../data/supabase.generated";
import { accessOwner } from "../agent-access/contract";
import { uploadEntry, uploadList, uploadQuota, uploadReservation, uploadReserveResult, uploadUsage, type UploadCatalog } from "./catalog-contract";
import { uploadId } from "./schema";

function adapter(call: (command: string, input: object) => Promise<unknown>, list: (owner: object) => Promise<unknown>, close: () => Promise<void>): UploadCatalog {
  const owned = (owner: Parameters<UploadCatalog["get"]>[0]) => accessOwner.parse(owner);
  return {
    async reserve(owner, input, quota) {
      return uploadReserveResult.parse(await call("reserve", { ...owned(owner),input: uploadReservation.parse(input),quota: uploadQuota.parse(quota) }));
    },
    async markStored(owner,id) { return z.boolean().parse(await call("markStored",{ ...owned(owner),id: uploadId.parse(id) })); },
    async get(owner,id) { return uploadEntry.nullable().parse(await call("get",{ ...owned(owner),id: uploadId.parse(id) })); },
    async list(owner) { return uploadList.parse(await list(owned(owner))); },
    async beginDelete(owner,id) { return z.boolean().parse(await call("beginDelete",{ ...owned(owner),id: uploadId.parse(id) })); },
    async finishDelete(owner,id) { return z.boolean().parse(await call("finishDelete",{ ...owned(owner),id: uploadId.parse(id) })); },
    async usage(owner) { return uploadUsage.parse(await call("usage",owned(owner))); },
    close,
  };
}

export function postgresUploadCatalog(connectionString: string): UploadCatalog {
  const pool = new Pool({ connectionString,max: 5,connectionTimeoutMillis: 5000,idleTimeoutMillis: 10_000,statement_timeout: 10_000 });
  pool.on("error", () => console.error(JSON.stringify({ event: "upload_catalog_pool_error" })));
  return adapter(async (command,input) => (await pool.query("SELECT public.app_upload_command($1,$2::jsonb) AS result",[command,JSON.stringify(input)])).rows[0].result,
    async owner => (await pool.query("SELECT public.app_upload_list($1::jsonb) AS result",[JSON.stringify(owner)])).rows[0].result,
    () => pool.end());
}

export function supabaseUploadCatalog(url: string, secret: string): UploadCatalog {
  const client = createClient<Database>(url,secret,{ auth: { persistSession: false,autoRefreshToken: false },global: {
    fetch: (input,init) => fetch(input,{ ...init,redirect: "error",signal: AbortSignal.timeout(10_000) }),
  } });
  return adapter(async (command,input) => {
    const { data,error } = await client.rpc("app_upload_command",{ command,input: z.json().parse(input) });
    if (error) throw error;
    return data;
  },async owner => {
    const { data,error } = await client.rpc("app_upload_list",{ input: z.json().parse(owner) });
    if (error) throw error;
    return data;
  },async () => {});
}

export function convexUploadCatalog(url: string, secret: string): UploadCatalog {
  const backend = new ConvexBackend(url,secret);
  return adapter((command,input) => backend.call(`upload.${command}`,input,z.unknown()),
    owner => backend.call("upload.list",owner,z.unknown()),async () => {});
}
