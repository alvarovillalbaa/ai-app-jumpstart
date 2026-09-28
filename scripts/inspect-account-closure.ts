import { isAbsolute,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccountSchemaSources,verifyAccountDataInventory } from "./account-data-inventory.mjs";
import { inspectPostgresAccountData,inspectSqliteAccountData } from "./inspect-account-data.mjs";
import { inspectConvexAccountData } from "./inspect-convex-account-data";
import { inspectAccountObjects } from "./inspect-account-objects";

type MetadataProvider = "sqlite" | "postgres" | "convex";
type ObjectProvider = "local" | "supabase" | "aws-s3";
type Owner = { tenant: string;subject: string };

/** One fail-closed operator report spanning application rows and private upload objects. */
export async function inspectAccountClosure(metadataProvider: MetadataProvider,objectProvider: ObjectProvider,
  owner: Owner,env: Record<string,string | undefined>) {
  if (!owner.tenant || !owner.subject || owner.tenant.length > 200 || owner.subject.length > 200 ||
      !["sqlite","postgres","convex"].includes(metadataProvider) || !["local","supabase","aws-s3"].includes(objectProvider))
    throw new Error("Invalid account closure inspection configuration.");
  verifyAccountDataInventory(readAccountSchemaSources());
  let rows;
  if (metadataProvider === "sqlite") {
    if (!env.ACCOUNT_AUDIT_SQLITE_PATH || !isAbsolute(env.ACCOUNT_AUDIT_SQLITE_PATH))
      throw new Error("An absolute SQLite account audit path is required.");
    rows = inspectSqliteAccountData(env.ACCOUNT_AUDIT_SQLITE_PATH,owner.tenant,owner.subject);
  } else if (metadataProvider === "postgres") {
    if (!env.DATABASE_URL) throw new Error("An application database URL is required.");
    rows = await inspectPostgresAccountData(env.DATABASE_URL,owner.tenant,owner.subject);
  } else {
    if (!env.CONVEX_SITE_URL || !env.CONVEX_AUDIT_SECRET) throw new Error("A Convex operator audit connection is required.");
    rows = await inspectConvexAccountData(env.CONVEX_SITE_URL,env.CONVEX_AUDIT_SECRET,owner.tenant,owner.subject);
  }
  const objects = await inspectAccountObjects(objectProvider,owner,env);
  const remaining = { applicationRows: rows.ownerRowTotal > 0,privateObjects: objects.objectCount > 0,
    globalUnattributableRows: rows.orphanRowTotal > 0 };
  return { format: "ai-app-jumpstart-account-closure-observation-v1",
    status: Object.values(remaining).some(Boolean) ? "retained_or_unattributable" : "unfenced_zero",
    metadataProvider,objectProvider,remaining,
    ownerRows: rows.ownerRows,orphanRows: rows.orphanRows,ownerRowTotal: rows.ownerRowTotal,
    orphanRowTotal: rows.orphanRowTotal,objectCount: objects.objectCount,
    inspectedEntities: Object.keys(rows.ownerRows).length,
    scope: "two separate application and object observations; no owner write fence, Auth, Eve, providers, logs, derived copies or backups" };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:inspect:closure -- --metadata sqlite|postgres|convex --read-only (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, UPLOAD_STORAGE_PROVIDER and both backend settings in the operator process environment)";
  const metadata = args[0] === "--metadata" ? args[1] : undefined,objects = env.UPLOAD_STORAGE_PROVIDER;
  if (args.length !== 3 || args[2] !== "--read-only" || !["sqlite","postgres","convex"].includes(metadata ?? "") ||
      !["local","supabase","aws-s3"].includes(objects ?? "") || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    const report = await inspectAccountClosure(metadata as MetadataProvider,objects as ObjectProvider,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },env);
    console.log(JSON.stringify(report,null,2));
  } catch {
    // Neither an identity nor a backend URL/path/key may enter diagnostics.
    console.error("Account closure inspection failed. Check metadata and object backend access and configuration.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
