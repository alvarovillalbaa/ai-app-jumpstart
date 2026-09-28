import { DatabaseSync } from "node:sqlite";
import { mkdirSync,mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { eraseAccountAuth } from "../../scripts/erase-account-auth";
import { eraseAccountRows } from "../../scripts/erase-account-rows";
import { exportAccountBundle } from "../../scripts/export-account-bundle";
import { setSqliteAccountFence } from "../../scripts/fence-account-writes";

const origin = "https://identity.example",owner = {
  tenant: `supabase:${origin}`,subject: "715ed5db-f090-4b8c-a067-640ecee36aa0" };

it("hard-deletes only the exact verified Auth identity after fenced application stores are empty",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-auth-erasure-"));
  const path = join(dir,"app.sqlite"),root = join(dir,"objects"),bundle = join(dir,"bundle");
  try {
    mkdirSync(root,{ mode: 0o700 });
    for (const store of [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)]) await store.close();
    const db = new DatabaseSync(path);
    try { db.prepare("INSERT INTO app_records VALUES('auth-record',?,?,'A','private',1,'now','now')")
      .run(owner.tenant,owner.subject); } finally { db.close(); }
    setSqliteAccountFence(path,owner);
    const env = { AUTH_PROVIDER: "supabase",SUPABASE_AUTH_URL: origin,
      SUPABASE_AUTH_ADMIN_KEY: "sb_secret_disposable_operator_fixture",ACCOUNT_AUDIT_SQLITE_PATH: path,UPLOAD_LOCAL_ROOT: root };
    await exportAccountBundle("sqlite","local",owner,bundle,env);
    let present = true,deletes = 0;
    const request: typeof fetch = async (input,init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(origin);
      expect(url.pathname).toBe(`/auth/v1/admin/users/${owner.subject}`);
      if (init?.method === "DELETE") {
        expect(JSON.parse(String(init.body))).toEqual({ should_soft_delete: false });
        present = false;deletes++;
        return Response.json({ id: owner.subject,role: "authenticated" });
      }
      return present ? Response.json({ id: owner.subject,role: "authenticated",is_anonymous: false })
        : Response.json({ code: "user_not_found",msg: "User not found" },{ status: 404 });
    };
    await expect(eraseAccountAuth(owner,bundle,env,false,request)).rejects.toThrow("remain");
    expect(deletes).toBe(0);
    await eraseAccountRows("sqlite",owner,bundle,env,true);
    await expect(eraseAccountAuth({ ...owner,tenant: "supabase:https://other.example" },bundle,env,true,request))
      .rejects.toThrow("invalid");
    await expect(eraseAccountAuth(owner,bundle,{ ...env,SUPABASE_AUTH_ADMIN_KEY: "sb_publishable_wrong_key" },true,request))
      .rejects.toThrow("invalid");
    expect(await eraseAccountAuth(owner,bundle,env,false,request)).toMatchObject({ status: "auth-identity-erasure-planned" });
    expect(await eraseAccountAuth(owner,bundle,env,true,request)).toMatchObject({ status: "auth-identity-erased" });
    expect(deletes).toBe(1);
    expect(await eraseAccountAuth(owner,bundle,env,true,request)).toMatchObject({ status: "auth-identity-already-absent" });
    expect(deletes).toBe(1);
  } finally { rmSync(dir,{ recursive: true,force: true }); }
},30_000);
