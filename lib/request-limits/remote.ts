import { Pool } from "pg";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../data/supabase.generated";
import { ConvexBackend } from "../data/convex-client";
import { limitInput,limitOwner,limitResult,type RequestLimitStore } from "./contract";

export function postgresRequestLimitStore(connectionString: string): RequestLimitStore {
  const pool = new Pool({ connectionString,max: 5,connectionTimeoutMillis: 5000,idleTimeoutMillis: 10000,statement_timeout: 10000 });
  pool.on("error",() => console.error(JSON.stringify({ event: "request_limit_pool_error" })));
  return { async claim(owner,limit) {
    const input = limitInput.parse({ ...limitOwner.parse(owner),limit });
    const { rows } = await pool.query("SELECT public.app_request_limit($1::jsonb) AS result",[JSON.stringify(input)]);
    return limitResult.parse(rows[0].result);
  },async health() { const { rows } = await pool.query("SELECT public.app_request_limits_ready() AS ready");z.literal(true).parse(rows[0].ready); },close: () => pool.end() };
}
export function supabaseRequestLimitStore(url: string,secret: string): RequestLimitStore {
  const client = createClient<Database>(url,secret,{ auth: { persistSession: false,autoRefreshToken: false },global: {
    fetch: (input,init) => fetch(input,{ ...init,redirect: "error",signal: AbortSignal.timeout(10000) }),
  } });
  return { async claim(owner,limit) {
    const input = limitInput.parse({ ...limitOwner.parse(owner),limit }),{ data,error } = await client.rpc("app_request_limit",{ input });
    if (error) throw error;return limitResult.parse(data);
  },async health() { const { data,error } = await client.rpc("app_request_limits_ready");if (error) throw error;z.literal(true).parse(data); },async close() {} };
}
export function convexRequestLimitStore(url: string,secret: string,request: typeof fetch = fetch): RequestLimitStore {
  const backend = new ConvexBackend(url,secret,request);
  return { claim: async (owner,limit) => backend.call("limit.claim",limitInput.parse({ ...limitOwner.parse(owner),limit }),limitResult),
    async health() { await backend.call("limit.health",{},z.literal(true)); },async close() {} };
}
