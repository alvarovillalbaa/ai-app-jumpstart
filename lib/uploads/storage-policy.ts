import { Pool } from "pg";

/** Fail closed if the canonical quarantine policy was skipped or changed. */
export async function verifyUploadStoragePolicy(connectionString: string) {
  if (!connectionString) throw new Error("DATABASE_URL is required to verify the upload Storage policy.");
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000, max: 1 });
  try {
    const { rows } = await pool.query<{
      relrowsecurity: boolean; permissive: string | null; cmd: string | null;
      roles: string | null; qual: string | null; with_check: string | null;
    }>(`SELECT c.relrowsecurity,p.permissive,p.cmd,p.roles::text AS roles,p.qual,p.with_check
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
          AND p.policyname='app_private_uploads_quarantine'
        WHERE n.nspname='storage' AND c.relname='objects'`);
    const expected = new Set(["(bucket_id <> 'app-private-uploads'::text)", "(bucket_id <> 'app-private-uploads')"]);
    if (!rows.some(row => row.relrowsecurity && row.permissive === "RESTRICTIVE" && row.cmd === "ALL" &&
        row.roles === "{public}" &&
        row.qual !== null && expected.has(row.qual) && row.with_check !== null && expected.has(row.with_check))) {
      throw new Error("The private upload Storage RLS policy is missing or changed; apply the canonical migration before provisioning.");
    }
  } finally { await pool.end(); }
}
