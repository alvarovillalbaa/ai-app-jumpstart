import { Client } from "pg";
import { z } from "zod";

function safeCount(value: unknown) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Auth session row count exceeded the supported range.");
  return count;
}

/** Count rows for one Auth subject without returning session identifiers or token data. */
export async function inspectSupabaseAuthSessionRows(connectionString: string,subjectInput: string,
  expectedIdentityPresent: boolean) {
  const subject = z.string().uuid().parse(subjectInput);
  const client = new Client({ connectionString,connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(`SELECT
      (SELECT count(*)::text FROM auth.users WHERE id=$1::uuid) AS user_rows,
      (SELECT count(*)::text FROM auth.sessions WHERE user_id=$1::uuid) AS session_rows`,[subject]);
    const userRows = safeCount(result.rows[0]?.user_rows),sessionRows = safeCount(result.rows[0]?.session_rows);
    if (userRows !== (expectedIdentityPresent ? 1 : 0))
      throw new Error("Auth database user presence did not match the Auth admin lookup.");
    await client.query("COMMIT");
    return sessionRows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { await client.end(); }
}
