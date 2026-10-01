import { expect, it } from "vitest";
import { Client } from "pg";
import { verifyUploadStoragePolicy } from "../../lib/uploads/storage-policy";

it("blocks direct quarantine-bucket access despite a broad Storage policy", async () => {
  await verifyUploadStoragePolicy(process.env.DATABASE_URL!);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const role of ["anon", "authenticated"]) {
      await client.query(`SET ROLE ${role}`);
      try {
        const visible = await client.query("SELECT bucket_id FROM storage.objects ORDER BY bucket_id");
        expect(visible.rows).toEqual([{ bucket_id: "other-bucket" }]);
        await expect(client.query("INSERT INTO storage.objects(bucket_id,name) VALUES ('app-private-uploads','forged')"))
          .rejects.toMatchObject({ code: "42501" });
        expect((await client.query("UPDATE storage.objects SET name='forged' WHERE bucket_id='app-private-uploads'")).rowCount).toBe(0);
        expect((await client.query("DELETE FROM storage.objects WHERE bucket_id='app-private-uploads'")).rowCount).toBe(0);
      } finally { await client.query("RESET ROLE"); }
    }
    const policy = await client.query("SELECT permissive,cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='app_private_uploads_quarantine'");
    expect(policy.rows).toEqual([{ permissive: "RESTRICTIVE", cmd: "ALL" }]);
  } finally { await client.end(); }
});
