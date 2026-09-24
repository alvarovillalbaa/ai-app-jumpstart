import { spawnSync } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = fileURLToPath(new URL("../lib/data/supabase.generated.ts", import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const localDatabaseUrl = args.includes("--local-db-url");
if (args.some(arg => !["--check", "--local-db-url"].includes(arg)) || new Set(args).size !== args.length || (localDatabaseUrl && !check)) {
  throw new Error("Usage: npm run db:types [-- --check [--local-db-url]]");
}

function supabase(args) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["--no-install", "supabase", ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Supabase CLI failed (${result.status ?? "spawn error"}). Check the selected disposable database.`);
  return result.stdout;
}

let databaseUrl;
if (localDatabaseUrl) {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error();
    databaseUrl = url.href;
  } catch { throw new Error("--local-db-url requires a loopback PostgreSQL DATABASE_URL for a disposable schema check."); }
} else {
  const status = JSON.parse(supabase(["status", "-o", "json"]));
  if (typeof status.DB_URL !== "string" || !status.DB_URL) throw new Error("Local Supabase status did not include a database URL.");
  databaseUrl = status.DB_URL;
}
const migration = spawnSync(process.execPath, ["scripts/migrate.ts", "--dry-run"], {
  cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl },
});
if (migration.status !== 0 || !migration.stdout.includes("0 pending migrations. No changes made.")) {
  throw new Error("The local Supabase schema is behind migrations/. Apply the repository migrations to this local database first.");
}
const generated = supabase(["gen", "types", "typescript", ...(localDatabaseUrl ? ["--db-url", databaseUrl] : ["--local"]), "--schema", "public"]);
if (!generated.includes("export type Database =")) throw new Error("Supabase CLI returned no database types.");
const source = `// Generated from the migrated local Supabase schema by npm run db:types. Do not edit.\n${generated.replaceAll("\r\n", "\n").trimEnd()}\n`;
if (check) {
  const committed = await readFile(destination, "utf8").catch(() => "");
  if (committed !== source) throw new Error("Supabase types are out of date. Run npm run db:types and commit the result.");
  console.log("Supabase types match the migrated local schema.");
} else {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, source);
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
  console.log("Wrote lib/data/supabase.generated.ts from the migrated local schema.");
}
