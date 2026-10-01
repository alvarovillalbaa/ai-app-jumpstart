import { requestLimitContract } from "../contracts/request-limits";
import { createRequestLimitStore } from "../../lib/request-limits/store";
import { expect,it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
if (!["postgres","supabase","convex"].includes(process.env.DATA_PROVIDER ?? "")) throw new Error("Use a disposable migrated provider for request limit contracts.");
requestLimitContract(process.env.DATA_PROVIDER!,createRequestLimitStore);

if (process.env.DATA_PROVIDER === "supabase") it("allows only the backend role to claim/probe quotas or read counters",async () => {
  if (!process.env.DATABASE_URL) throw new Error("Supabase permission contracts require a disposable DATABASE_URL.");
  const probe = new Client({ connectionString: process.env.DATABASE_URL });await probe.connect();
  const input = { tenant: randomUUID(),subject: randomUUID(),limit: 2 };
  try {
    expect((await probe.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.app_request_limits'::regclass")).rows[0].relrowsecurity).toBe(true);
    for (const role of ["anon","authenticated"]) {
      await probe.query(`SET ROLE ${role}`);
      try {
        await expect(probe.query("SELECT * FROM public.app_request_limits LIMIT 1")).rejects.toMatchObject({ code: "42501" });
        await expect(probe.query("SELECT public.app_request_limit($1::jsonb)",[JSON.stringify(input)])).rejects.toMatchObject({ code: "42501" });
        await expect(probe.query("SELECT public.app_request_limits_ready()")).rejects.toMatchObject({ code: "42501" });
      } finally { await probe.query("RESET ROLE"); }
    }
    await probe.query("SET ROLE service_role");
    try {
      expect((await probe.query("SELECT public.app_request_limits_ready() AS ready")).rows[0].ready).toBe(true);
      expect((await probe.query("SELECT public.app_request_limit($1::jsonb) AS result",[JSON.stringify(input)])).rows[0].result).toMatchObject({ allowed: true,remaining: 1 });
    } finally { await probe.query("RESET ROLE"); }
  } finally { await probe.end(); }
});
