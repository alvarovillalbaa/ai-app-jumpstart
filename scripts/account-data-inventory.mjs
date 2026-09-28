import { readFileSync,readdirSync } from "node:fs";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every application table must have an owner path before account erasure can be designed. */
export const accountDataInventory = Object.freeze([
  { entity: "records",sql: "app_records",sqlite: "app_records",convex: "records",owner: "direct" },
  { entity: "recordCreates",sql: "app_record_creates",sqlite: "app_record_creates",convex: "recordCreates",owner: "direct" },
  { entity: "conversations",sql: "app_conversations",sqlite: "app_conversations",convex: "conversations",owner: "direct" },
  { entity: "conversationEvents",sql: "app_conversation_events",sqlite: "app_conversation_events",convex: "conversationEvents",owner: "conversations",via: ["operation_id","operation_id"] },
  { entity: "conversationRuns",sql: "app_conversation_runs",sqlite: "app_conversation_runs",convex: "conversationRuns",owner: "conversations",via: ["operation_id","operation_id"] },
  { entity: "artifacts",sql: "app_artifacts",sqlite: "app_artifacts",convex: "artifacts",owner: "conversations",via: ["operation_id","operation_id"] },
  { entity: "artifactVersions",sql: "app_artifact_versions",sqlite: "app_artifact_versions",convex: "artifactVersions",owner: "artifacts",via: ["artifact_id","id"] },
  { entity: "budgetAccounts",sql: "app_budget_accounts",convex: "budgetAccounts",owner: "direct" },
  { entity: "budgetDays",convex: "budgetDays",owner: "direct" },
  { entity: "budgetReservations",sql: "app_budget_reservations",sqlite: "app_budget_reservations",convex: "budgetReservations",owner: "direct" },
  { entity: "budgetAttempts",sql: "app_budget_attempts",sqlite: "app_budget_attempts",convex: "budgetAttempts",owner: "budgetReservations",via: ["operation_id","operation_id"] },
  { entity: "budgetCorrections",sql: "app_budget_corrections",sqlite: "app_budget_corrections",convex: "budgetCorrections",owner: "direct" },
  { entity: "uploads",sql: "app_uploads",sqlite: "app_uploads",convex: "uploads",owner: "direct" },
  { entity: "uploadScans",sql: "app_upload_scans",sqlite: "app_upload_scans",owner: "uploads",via: ["upload_id","id"] },
  { entity: "uploadReviews",sql: "app_upload_reviews",sqlite: "app_upload_reviews",convex: "uploadReviews",owner: "uploads",via: ["upload_id","id"] },
  { entity: "userPreferences",sql: "app_user_preferences",sqlite: "app_user_preferences",convex: "userPreferences",owner: "direct" },
  { entity: "requestLimits",sql: "app_request_limits",sqlite: "app_request_limits",convex: "requestLimits",owner: "direct" },
  { entity: "internalNonces",sql: "app_internal_nonces",sqlite: "app_internal_nonces",convex: "internalNonces",owner: "global-expiring" },
  { entity: "accountFences",sql: "app_private.account_fences",sqlite: "app_account_fences",convex: "accountFences",owner: "closure-control" },
]);

const root = fileURLToPath(new URL("../",import.meta.url));

export function readAccountSchemaSources(base = root) {
  const migrationDir = join(base,"migrations");
  const sql = readdirSync(migrationDir).filter(name => name.endsWith(".sql")).sort()
    .map(name => readFileSync(join(migrationDir,name),"utf8")).join("\n");
  function sqliteDefinitions(dir) {
    return readdirSync(dir,{ withFileTypes: true }).flatMap(entry => {
      const path = join(dir,entry.name);
      if (entry.isDirectory()) return sqliteDefinitions(path);
      if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
      const source = readFileSync(path,"utf8");
      return /\bCREATE\s+TABLE\b/i.test(source) ? [source] : [];
    });
  }
  const sqlite = sqliteDefinitions(join(base,"lib")).join("\n");
  const convex = readFileSync(join(base,"convex/schema.ts"),"utf8");
  return { sql,sqlite,convex };
}

function sqlTables(source) {
  const matches = [...source.matchAll(/\bCREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"?[a-z][a-z0-9_]*"?\.)?"?[a-z][a-z0-9_]*"?)\s*\(/gi)];
  return new Map(matches.map((match,index) => {
    const remaining = source.slice(match.index,matches[index+1]?.index ?? source.length);
    const end = remaining.indexOf(");");
    const name = match[1].replaceAll('"',"").toLowerCase().replace(/^public\./,"");
    return [name,end < 0 ? remaining : remaining.slice(0,end+2)];
  }));
}

function convexTables(source) {
  const matches = [...source.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*defineTable\(/gm)];
  return new Map(matches.map((match,index) => [match[1],source.slice(match.index,matches[index+1]?.index ?? source.length)]));
}

function sameTables(actual,expected,label) {
  const missing = [...expected].filter(table => !actual.has(table));
  const unknown = [...actual.keys()].filter(table => !expected.has(table));
  if (missing.length || unknown.length) throw new Error(`${label} account data inventory drift: missing [${missing.sort()}], unclassified [${unknown.sort()}].`);
}

export function verifyAccountDataInventory(sources,entries = accountDataInventory) {
  const entities = new Map(entries.map(entry => [entry.entity,entry]));
  if (entities.size !== entries.length) throw new Error("Duplicate account inventory entity.");
  for (const entry of entries) {
    if (entry.owner !== "direct" && entry.owner !== "global-expiring" && entry.owner !== "closure-control" &&
      (!entities.has(entry.owner) || entities.get(entry.owner).owner === "global-expiring"))
      throw new Error(`Unresolved account owner path for ${entry.entity}.`);
    if (entry.owner !== "direct" && entry.owner !== "global-expiring" && entry.owner !== "closure-control" &&
      (!Array.isArray(entry.via) || entry.via.length !== 2 || entry.via.some(column => !/^[a-z][a-z0-9_]*$/.test(column))))
      throw new Error(`Account owner join missing for ${entry.entity}.`);
    const visited = new Set([entry.entity]);
    let parent = entry;
    while (parent.owner !== "direct" && parent.owner !== "global-expiring" && parent.owner !== "closure-control") {
      if (visited.has(parent.owner)) throw new Error(`Cyclic account owner path for ${entry.entity}.`);
      visited.add(parent.owner);
      parent = entities.get(parent.owner);
      if (!parent) throw new Error(`Unresolved account owner path for ${entry.entity}.`);
    }
  }
  const sql = sqlTables(sources.sql),sqlite = sqlTables(sources.sqlite),convex = convexTables(sources.convex);
  // The old SQLite upload CHECK constraint is rebuilt through this temporary table.
  // If that rename disappears, treat it as an unclassified persistent table.
  if (sqlite.has("app_uploads_scan_upgrade") && /\bALTER\s+TABLE\s+app_uploads_scan_upgrade\s+RENAME\s+TO\s+app_uploads\b/i.test(sources.sqlite))
    sqlite.delete("app_uploads_scan_upgrade");
  for (const [label,actual,key] of [["PostgreSQL/Supabase",sql,"sql"],["SQLite",sqlite,"sqlite"],["Convex",convex,"convex"]])
    sameTables(actual,new Set(entries.map(entry => entry[key]).filter(Boolean)),label);
  for (const entry of entries.filter(entry => entry.owner === "direct")) {
    for (const [label,tables,key] of [["PostgreSQL/Supabase",sql,"sql"],["SQLite",sqlite,"sqlite"],["Convex",convex,"convex"]]) {
      if (!entry[key]) continue;
      const definition = tables.get(entry[key]);
      if (!/\btenant\b/.test(definition) || !/\bsubject\b/.test(definition))
        throw new Error(`${label} owner columns missing from ${entry[key]}.`);
    }
  }
  for (const entry of entries.filter(entry => entry.owner === "global-expiring")) {
    for (const [label,tables,key] of [["PostgreSQL/Supabase",sql,"sql"],["SQLite",sqlite,"sqlite"],["Convex",convex,"convex"]]) {
      if (entry[key] && !/\b(?:expires_at|expiresAt)\b/.test(tables.get(entry[key])))
        throw new Error(`${label} expiration column missing from ${entry[key]}.`);
    }
  }
  for (const entry of entries.filter(entry => entry.owner === "closure-control")) {
    for (const [label,tables,key] of [["PostgreSQL/Supabase",sql,"sql"],["SQLite",sqlite,"sqlite"],["Convex",convex,"convex"]]) {
      if (entry[key] && (!/\btenant\b/.test(tables.get(entry[key])) || !/\bsubject\b/.test(tables.get(entry[key]))))
        throw new Error(`${label} closure-control owner columns missing from ${entry[key]}.`);
    }
  }
  return { postgres: sql.size,sqlite: sqlite.size,convex: convex.size,ownerLinked: entries.filter(entry => entry.owner !== "global-expiring" && entry.owner !== "closure-control").length };
}

/** Backend-only owner-row probes, including soft-deleted rows and child tables. */
export function accountOwnerCountQueries(provider) {
  if (provider !== "sqlite" && provider !== "sql") throw new Error("Account row probes support SQLite or PostgreSQL/Supabase.");
  const entities = new Map(accountDataInventory.map(entry => [entry.entity,entry]));
  const table = entry => provider === "sql" ? `public.${entry.sql}` : entry.sqlite;
  const parameters = provider === "sql" ? ["$1","$2"] : ["?","?"];
  return accountDataInventory.filter(entry => entry[provider] && entry.owner !== "global-expiring" && entry.owner !== "closure-control").map(entry => {
    let current = entry,index = 0;
    const joins = [];
    while (current.owner !== "direct") {
      const parent = entities.get(current.owner);
      joins.push(`JOIN ${table(parent)} AS t${index+1} ON t${index}.${current.via[0]}=t${index+1}.${current.via[1]}`);
      current = parent;index++;
    }
    return { entity: entry.entity,sql: `SELECT COUNT(*) AS count FROM ${table(entry)} AS t0 ${joins.join(" ")} WHERE t${index}.tenant=${parameters[0]} AND t${index}.subject=${parameters[1]}` };
  });
}

/** Unattributable child rows must be investigated before any erasure claim. */
export function accountOrphanCountQueries(provider) {
  if (provider !== "sqlite" && provider !== "sql") throw new Error("Account orphan probes support SQLite or PostgreSQL/Supabase.");
  const entities = new Map(accountDataInventory.map(entry => [entry.entity,entry]));
  const table = entry => provider === "sql" ? `public.${entry.sql}` : entry.sqlite;
  return accountDataInventory.filter(entry => entry[provider] && entry.owner !== "direct" && entry.owner !== "global-expiring" && entry.owner !== "closure-control")
    .map(entry => {
      const parent = entities.get(entry.owner);
      return { entity: entry.entity,sql: `SELECT COUNT(*) AS count FROM ${table(entry)} AS child LEFT JOIN ${table(parent)} AS parent ON child.${entry.via[0]}=parent.${entry.via[1]} WHERE parent.${entry.via[1]} IS NULL` };
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyAccountDataInventory(readAccountSchemaSources());
    console.log(`Account data inventory: ${result.ownerLinked} owner-linked entities; PostgreSQL/Supabase ${result.postgres}, SQLite ${result.sqlite}, Convex ${result.convex} tables classified.`);
  } catch (error) { console.error(error instanceof Error ? error.message : "Account data inventory check failed.");process.exitCode = 1; }
}
