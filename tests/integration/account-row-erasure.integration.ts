import { randomUUID } from "node:crypto";
import { mkdirSync,mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect,it } from "vitest";
import { eraseAccountRows } from "../../scripts/erase-account-rows";
import { exportAccountBundle } from "../../scripts/export-account-bundle";
import { setPostgresAccountFence } from "../../scripts/fence-account-writes";

if (["postgres","supabase"].includes(process.env.DATA_PROVIDER ?? "")) {
  it("deletes only archived PostgreSQL owner rows while retaining foreign rows and the permanent fence",async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("A disposable migrated PostgreSQL database is required.");
    const dir = mkdtempSync(join(tmpdir(),"jumpstart-postgres-erasure-"));
    const root = join(dir,"objects"),bundle = join(dir,"bundle");
    const tenant = randomUUID(),owner = { tenant,subject: randomUUID() },foreign = { tenant,subject: randomUUID() };
    const ownedId = randomUUID(),foreignId = randomUUID(),operationId = randomUUID();
    const client = new Client({ connectionString: url });
    let connected = false;
    try {
      mkdirSync(root,{ mode: 0o700 });
      await client.connect();connected = true;
      await client.query("INSERT INTO public.app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,'Owned','private')",
        [ownedId,owner.tenant,owner.subject]);
      await client.query("INSERT INTO public.app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,'Foreign','retained')",
        [foreignId,foreign.tenant,foreign.subject]);
      await client.query("INSERT INTO public.app_budget_accounts(tenant,subject) VALUES($1,$2)",
        [owner.tenant,owner.subject]);
      await client.query("INSERT INTO public.app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status) VALUES($1,$2,$3,$4,'test',1,1,1,'reserved')",
        [operationId,owner.tenant,owner.subject,"a".repeat(64)]);
      await client.query("INSERT INTO public.app_budget_attempts(operation_id,attempt_id) VALUES($1,$2)",
        [operationId,"b".repeat(64)]);
      await setPostgresAccountFence(url,owner);
      const env = { DATABASE_URL: url,UPLOAD_LOCAL_ROOT: root };
      await exportAccountBundle("postgres","local",owner,bundle,env);
      await expect(eraseAccountRows("postgres",owner,bundle,env)).resolves.toMatchObject({ rows: 4,
        status: "application-row-erasure-planned" });
      expect((await client.query("SELECT content FROM public.app_records WHERE id=$1",[ownedId])).rows[0]?.content).toBe("private");
      await expect(eraseAccountRows("postgres",owner,bundle,env,true)).resolves.toMatchObject({ rows: 4,
        status: "application-rows-erased" });
      expect((await client.query("SELECT 1 FROM public.app_records WHERE id=$1",[ownedId])).rowCount).toBe(0);
      expect((await client.query("SELECT content FROM public.app_records WHERE id=$1",[foreignId])).rows[0]?.content).toBe("retained");
      expect((await client.query("SELECT 1 FROM app_private.account_fences WHERE tenant=$1 AND subject=$2",
        [owner.tenant,owner.subject])).rowCount).toBe(1);
      await expect(client.query("INSERT INTO public.app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,'Late','denied')",
        [randomUUID(),owner.tenant,owner.subject])).rejects.toThrow("fenced");
    } finally {
      if (connected) {
        await client.query("DELETE FROM public.app_records WHERE id=$1",[foreignId]).catch(() => {});
        await client.end();
      }
      rmSync(dir,{ recursive: true,force: true });
    }
  },30_000);
}
