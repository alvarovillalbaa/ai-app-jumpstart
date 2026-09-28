import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open,readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { accountDataInventory,accountOwnerRowQueries,readAccountSchemaSources,
  verifyAccountDataInventory } from "./account-data-inventory.mjs";
import { verifyAccountBundle } from "./export-account-bundle";

const entities = accountDataInventory.filter(entry => entry.sql &&
  entry.owner !== "global-expiring" && entry.owner !== "closure-control");
const tables = entities.map(entry => `public.${entry.sql}`);
const byEntity = new Map(entities.map((entry,index) => [entry.entity,{ table: `public.${entry.sql}`,index }]));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function disposableTarget(connectionString: string) {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:","postgresql:"].includes(url.protocol) ||
      !["127.0.0.1","localhost","[::1]"].includes(url.hostname) ||
      url.search || url.hash ||
      !/^app_account_rehearsal_[a-z0-9_]+$/u.test(database))
    throw new Error("PostgreSQL account rehearsal requires a named disposable loopback database.");
}

async function* archiveRows(path: string) {
  const file = await open(path,fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try {
      for await (const line of reader) yield z.object({ type: z.string(),value: z.unknown() }).strict().parse(JSON.parse(line));
    } finally { reader.close(); }
  } finally { await file.close(); }
}

async function assertCurrentEmptyTarget(client: Client) {
  const available = (await readdir(new URL("../migrations/",import.meta.url)))
    .filter(name => /^\d+_[a-z0-9_]+\.sql$/u.test(name)).sort();
  const applied = (await client.query<{ name: string }>("SELECT name FROM public.app_migrations ORDER BY name"))
    .rows.map(row => row.name);
  if (JSON.stringify(applied) !== JSON.stringify(available))
    throw new Error("PostgreSQL account rehearsal target must have the current exact migrations.");
  for (const table of [...tables,"public.app_internal_nonces","app_private.account_fences"]) {
    const result = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
    if (result.rows[0]?.count !== "0") throw new Error("PostgreSQL account rehearsal target is not empty.");
    const restricted = await client.query<{ active: boolean }>("SELECT row_security_active($1::regclass) AS active",[table]);
    if (restricted.rows[0]?.active) throw new Error("PostgreSQL account rehearsal requires backend table access.");
  }
}

/** Prove row import against an empty, current loopback schema, then roll back every write. */
export async function rehearsePostgresAccountBundle(sourceInput: string,targetUrl: string) {
  disposableTarget(targetUrl);
  const source = resolve(sourceInput),bundle = await verifyAccountBundle(source);
  if (bundle.metadataProvider !== "postgres")
    throw new Error("PostgreSQL account rehearsal requires PostgreSQL metadata.");
  verifyAccountDataInventory(readAccountSchemaSources());
  const client = new Client({ connectionString: targetUrl,connectionTimeoutMillis: 5_000 });
  let connected = false,begun = false;
  try {
    await client.connect();connected = true;
    const sequenceBefore = await client.query<{ last_value: string;is_called: boolean }>(
      "SELECT last_value::text,is_called FROM public.app_conversation_events_ordinal_seq");
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");begun = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(`LOCK TABLE ${[...tables,"public.app_internal_nonces","app_private.account_fences"].join(",")} IN ACCESS EXCLUSIVE MODE`);
    await assertCurrentEmptyTarget(client);
    const capture = await client.query<{ tgenabled: string;proname: string }>(`SELECT t.tgenabled,p.proname
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='public.app_conversation_events'::regclass AND t.tgname='app_capture_conversation_run'`);
    if (capture.rows.length !== 1 || capture.rows[0].tgenabled !== "O" ||
        capture.rows[0].proname !== "app_capture_conversation_run")
      throw new Error("PostgreSQL account rehearsal target run-cache trigger differs.");
    // The bundle already contains materialized run rows. Keep this one derived
    // write from duplicating them inside the disposable import transaction.
    await client.query("ALTER TABLE public.app_conversation_events DISABLE TRIGGER app_capture_conversation_run");
    const columns = new Map<string,string[]>(),expected = new Map<string,string[]>();
    let owner: AccessOwner | null = null,lastEntity = -1,rows = 0;
    for await (const item of archiveRows(resolve(source,"rows.ndjson"))) {
      if (item.type === "manifest") {
        if (owner) throw new Error("PostgreSQL account rehearsal archive has a duplicate owner.");
        owner = z.object({ owner: accessOwner }).passthrough().parse(item.value).owner;
        continue;
      }
      if (item.type !== "row") continue;
      if (!owner) throw new Error("PostgreSQL account rehearsal archive has no owner.");
      const row = z.object({ entity: z.string(),rowJson: z.string() }).strict().parse(item.value);
      const entry = byEntity.get(row.entity);
      if (!entry || entry.index < lastEntity) throw new Error("PostgreSQL account rehearsal archive has unsupported row order.");
      lastEntity = entry.index;
      let names = columns.get(row.entity);
      if (!names) {
        names = (await client.query<{ attname: string }>(`SELECT attname FROM pg_attribute
          WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[entry.table]))
          .rows.map(column => column.attname);
        if (!names.length) throw new Error("PostgreSQL account rehearsal target table is missing.");
        columns.set(row.entity,names);
      }
      const parsed = JSON.parse(row.rowJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
          JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([...names].sort()))
        throw new Error("PostgreSQL account rehearsal archive differs from the current table shape.");
      const canonical = (await client.query<{ value: string }>("SELECT $1::jsonb::text AS value",[row.rowJson])).rows[0]?.value;
      if (!canonical) throw new Error("PostgreSQL account rehearsal row is invalid.");
      const override = row.entity === "conversationEvents" ? " OVERRIDING SYSTEM VALUE" : "";
      const inserted = await client.query(`INSERT INTO ${entry.table}${override}
        SELECT (json_populate_record(NULL::${entry.table},$1::json)).*`,[row.rowJson]);
      if (inserted.rowCount !== 1) throw new Error("PostgreSQL account rehearsal did not import exactly one row.");
      const hashes = expected.get(row.entity) ?? [];
      hashes.push(digest(canonical));expected.set(row.entity,hashes);rows++;
    }
    if (!owner || rows !== bundle.rows) throw new Error("PostgreSQL account rehearsal row count differs from the bundle.");
    await client.query("ALTER TABLE public.app_conversation_events ENABLE TRIGGER app_capture_conversation_run");
    let checked = 0;
    for (const query of accountOwnerRowQueries("sql")) {
      const entry = byEntity.get(query.entity)!;
      const sql = query.sql.replace("row_to_json(t0)::text AS row_json","row_to_json(t0)::jsonb::text AS row_json");
      if (sql === query.sql) throw new Error("PostgreSQL account rehearsal cannot normalize target rows.");
      const actual = (await client.query<{ row_json: string }>(sql,[owner.tenant,owner.subject]))
        .rows.map(row => digest(row.row_json)).sort();
      const wanted = (expected.get(query.entity) ?? []).sort();
      const total = (await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${entry.table}`)).rows[0]?.count;
      if (total !== String(actual.length) || JSON.stringify(actual) !== JSON.stringify(wanted))
        throw new Error("PostgreSQL account rehearsal rows differ from the bundle or contain another owner.");
      checked += actual.length;
    }
    if (checked !== bundle.rows) throw new Error("PostgreSQL account rehearsal total differs from the bundle.");
    await verifyAccountBundle(source);
    await client.query("ROLLBACK");begun = false;
    await assertCurrentEmptyTarget(client);
    const sequenceAfter = await client.query<{ last_value: string;is_called: boolean }>(
      "SELECT last_value::text,is_called FROM public.app_conversation_events_ordinal_seq");
    const triggerAfter = await client.query<{ tgenabled: string }>(`SELECT tgenabled FROM pg_trigger
      WHERE tgrelid='public.app_conversation_events'::regclass AND tgname='app_capture_conversation_run'`);
    if (JSON.stringify(sequenceAfter.rows) !== JSON.stringify(sequenceBefore.rows) ||
        triggerAfter.rows.length !== 1 || triggerAfter.rows[0].tgenabled !== "O")
      throw new Error("PostgreSQL account rehearsal left target control state changed.");
    return { provider: "postgres",rows: checked,objectsVerified: bundle.objects,status: "rolled-back-rehearsal" };
  } finally {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    if (connected) await client.end();
  }
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  if (args.length !== 2 || args[0] !== "--source" || !args[1] || !env.ACCOUNT_REHEARSAL_DATABASE_URL) {
    console.error("Usage: npm run account:rehearse:postgres -- --source /private/bundle (set ACCOUNT_REHEARSAL_DATABASE_URL to an empty migrated loopback app_account_rehearsal_* database).");
    process.exitCode = 2;return;
  }
  try { console.log(JSON.stringify(await rehearsePostgresAccountBundle(args[1],env.ACCOUNT_REHEARSAL_DATABASE_URL))); }
  catch { console.error("PostgreSQL account rehearsal failed. Check the verified bundle and isolated current-schema target.");process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
