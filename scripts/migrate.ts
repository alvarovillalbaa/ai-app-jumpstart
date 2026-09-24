import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--dry-run") || args.length > 1) throw new Error("Usage: npm run db:migrate [-- --dry-run]");
const dryRun = args.includes("--dry-run");
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the database to migrate.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
function assertKnownMigrations(applied: Set<string>, available: string[]) {
  const known = new Set(available);
  const unknown = [...applied].filter(name => !known.has(name));
  if (unknown.length) throw new Error(`Database has applied migrations absent from this checkout: ${unknown.join(", ")}`);
}
try {
  const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (dryRun) {
    await client.query("BEGIN READ ONLY");
    const exists = await client.query<{ name: string | null }>("SELECT to_regclass('app_migrations')::text AS name");
    const applied = exists.rows[0]?.name
      ? new Set((await client.query<{ name: string }>("SELECT name FROM app_migrations")).rows.map(row => row.name))
      : new Set<string>();
    assertKnownMigrations(applied, migrations);
    const pending = migrations.filter(name => !applied.has(name));
    for (const name of pending) console.log(`Pending ${name}`);
    console.log(`${pending.length} pending migration${pending.length === 1 ? "" : "s"}. No changes made.`);
    await client.query("COMMIT");
  } else {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(731829)");
    await client.query("CREATE TABLE IF NOT EXISTS app_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query<{ name: string }>("SELECT name FROM app_migrations")).rows.map(row => row.name));
    assertKnownMigrations(applied, migrations);
    for (const name of migrations) {
      if (applied.has(name)) continue;
      await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await client.query("INSERT INTO app_migrations(name) VALUES($1)", [name]);
      console.log(`Applied ${name}`);
    }
    await client.query("COMMIT");
  }
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await pool.end(); }
