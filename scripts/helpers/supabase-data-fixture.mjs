import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { installPostgrest } from "../testing/postgrest.mjs";
import { testCommand } from "./test-command.mjs";

/** Real migrated application database and JWT-enforcing PostgREST, no hosted credentials. */
export async function startSupabaseDataFixture({ databaseUrl,jwtSecret,directory }) {
  if (new URL(databaseUrl).hostname !== "127.0.0.1") throw new Error("The Auth data fixture requires a disposable loopback database.");
  const database = new Client({ connectionString: databaseUrl,connectionTimeoutMillis: 5000 });
  await database.connect();
  try {
    await database.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;`);
  } finally { await database.end(); }
  await testCommand(process.execPath,["scripts/migrate.ts"],{
    env: { ...process.env,DATABASE_URL: databaseUrl },
  },[databaseUrl,jwtSecret]);
  const executable = await installPostgrest(join(directory,"postgrest"));
  const listener = createServer();listener.listen(0,"127.0.0.1");await once(listener,"listening");
  const port = listener.address().port;await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(executable,[],{ env: { ...process.env,
    PGRST_DB_URI: databaseUrl,PGRST_DB_SCHEMAS: "public",PGRST_DB_ANON_ROLE: "anon",PGRST_JWT_SECRET: jwtSecret,
    PGRST_SERVER_HOST: "127.0.0.1",PGRST_SERVER_PORT: String(port),PGRST_LOG_LEVEL: "crit",
    ...(process.platform === "darwin" ? { DYLD_LIBRARY_PATH: fileURLToPath(new URL(`../../node_modules/@embedded-postgres/darwin-${process.arch}/native/lib`,import.meta.url)) } : {}),
  },stdio: ["ignore","ignore","ignore"] });
  let spawnFailed = false;child.on("error",() => { spawnFailed = true; });
  async function stop() {
    if (spawnFailed || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child,"close");child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"),5000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  try {
    const deadline = Date.now()+30_000;
    while (true) {
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) throw new Error("PostgREST fixture stopped before readiness.");
      if (await fetch(`${origin}/`,{ signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false)) break;
      if (Date.now() >= deadline) throw new Error("PostgREST fixture readiness timed out.");
      await new Promise(resolve => setTimeout(resolve,100));
    }
    return { origin,stop };
  } catch (error) { await stop();throw error; }
}
