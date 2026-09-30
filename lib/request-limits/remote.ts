import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../data/supabase.generated";
import { ConvexBackend } from "../data/convex-client";
import { acquirePostgresPool } from "../data/postgres-pool";
import { limitInput,limitOwner,limitResult,limitSnapshot,snapshotFromRow,type RequestLimitStore } from "./contract";

export function postgresRequestLimitStore(connectionString: string,poolMax = 5): RequestLimitStore {
  const { pool,release } = acquirePostgresPool(connectionString,poolMax);
  return { async claim(owner,limit) {
    const input = limitInput.parse({ ...limitOwner.parse(owner),limit });
    const { rows } = await pool.query("SELECT public.app_request_limit($1::jsonb) AS result",[JSON.stringify(input)]);
    return limitResult.parse(rows[0].result);
  },async snapshot(owner) {
    const input = limitOwner.parse(owner);
    const { rows } = await pool.query("SELECT bucket,counter FROM public.app_request_limits WHERE tenant=$1 AND subject=$2",[input.tenant,input.subject]);
    return snapshotFromRow(rows[0] ?? null);
  },async health() { const { rows } = await pool.query("SELECT public.app_request_limits_ready() AS ready");z.literal(true).parse(rows[0].ready); },close: release };
}
export function supabaseRequestLimitStore(url: string,secret: string): RequestLimitStore {
  const client = createClient<Database>(url,secret,{ auth: { persistSession: false,autoRefreshToken: false },global: {
    fetch: (input,init) => fetch(input,{ ...init,redirect: "error",signal: AbortSignal.timeout(10000) }),
  } });
  return { async claim(owner,limit) {
    const input = limitInput.parse({ ...limitOwner.parse(owner),limit }),{ data,error } = await client.rpc("app_request_limit",{ input });
    if (error) throw error;return limitResult.parse(data);
  },async snapshot(owner) {
    const input = limitOwner.parse(owner);
    const { data,error } = await client.from("app_request_limits").select("bucket,counter")
      .eq("tenant",input.tenant).eq("subject",input.subject).maybeSingle();
    if (error) throw error;
    return snapshotFromRow(data);
  },async health() { const { data,error } = await client.rpc("app_request_limits_ready");if (error) throw error;z.literal(true).parse(data); },async close() {} };
}
export function convexRequestLimitStore(url: string,secret: string,request: typeof fetch = fetch): RequestLimitStore {
  const backend = new ConvexBackend(url,secret,request);
  return { claim: async (owner,limit) => backend.call("limit.claim",limitInput.parse({ ...limitOwner.parse(owner),limit }),limitResult),
    snapshot: async owner => backend.call("limit.snapshot",limitOwner.parse(owner),limitSnapshot),
    async health() { await backend.call("limit.health",{},z.literal(true)); },async close() {} };
}
