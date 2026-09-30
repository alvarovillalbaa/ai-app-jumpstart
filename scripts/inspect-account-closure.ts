import { isAbsolute,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccountSchemaSources,verifyAccountDataInventory } from "./account-data-inventory.mjs";
import { inspectPostgresAccountData,inspectSqliteAccountData } from "./inspect-account-data.mjs";
import { inspectConvexAccountData } from "./inspect-convex-account-data";
import { inspectAccountObjects } from "./inspect-account-objects";
import { inspectAccountAuth } from "./inspect-account-auth";
import { inspectAccountWorkflow } from "./inspect-account-workflow.mjs";

type MetadataProvider = "sqlite" | "postgres" | "convex";
type ObjectProvider = "local" | "supabase" | "aws-s3";
type Owner = { tenant: string;subject: string };

/** One fail-closed operator report spanning application rows, their write fence, configured Auth identity and private objects. */
export async function inspectAccountClosure(metadataProvider: MetadataProvider,objectProvider: ObjectProvider,
  owner: Owner,env: Record<string,string | undefined>,request: typeof fetch = fetch,
  options: { workflowPostgres?: boolean } = {}) {
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
    rows = await inspectConvexAccountData(env.CONVEX_SITE_URL,env.CONVEX_AUDIT_SECRET,owner.tenant,owner.subject,request);
  }
  const auth = await inspectAccountAuth(owner,env,request);
  const objects = await inspectAccountObjects(objectProvider,owner,env);
  const workflow = options.workflowPostgres ? await inspectAccountWorkflow(metadataProvider,owner,env,request) : null;
  const workflowRowsRemain = workflow ? Object.values(workflow.linkedRuns).some(count => count > 0) : null;
  const remaining = { applicationRows: rows.ownerRowTotal > 0,privateObjects: objects.objectCount > 0,
    globalUnattributableRows: rows.orphanRowTotal > 0,applicationWritesPossible: !rows.applicationWriteFenced,
    authIdentity: auth.authIdentityPresent,workflowRows: workflowRowsRemain };
  const observedDataRemains = remaining.applicationRows || remaining.privateObjects || remaining.globalUnattributableRows ||
    remaining.authIdentity || remaining.workflowRows === true;
  return { format: "ai-app-jumpstart-account-closure-observation-v2",
    status: observedDataRemains ? "retained_or_unattributable"
      : rows.applicationWriteFenced ? "application_fenced_zero" : "unfenced_zero",
    metadataProvider,objectProvider,authProvider: auth.authProvider,
    authIdentityApplicable: auth.authIdentityApplicable,authIdentityPresent: auth.authIdentityPresent,remaining,
    applicationWriteFenced: rows.applicationWriteFenced,
    ownerRows: rows.ownerRows,orphanRows: rows.orphanRows,ownerRowTotal: rows.ownerRowTotal,
    orphanRowTotal: rows.orphanRowTotal,objectCount: objects.objectCount,
    workflow: workflow ? { provider: "postgres",boundSessionCount: workflow.boundSessionCount,
      linkedRuns: workflow.linkedRuns,otherSessionRoots: workflow.otherSessionRoots } : null,
    inspectedEntities: Object.keys(rows.ownerRows).length,
    scope: `SQLite/PostgreSQL row counts and permanent row-fence status share one read snapshot; Convex bounded counts and its fence query are separate snapshots. When Supabase Auth is configured, an operator lookup checks the exact registered user without returning identity fields; api-key mode has no Auth identity. Private objects are a separate observation.${workflow ? " Linked PostgreSQL Workflow runs and child-row counts use separate application-binding and Workflow read snapshots; unlinked or auxiliary runs are not attributed." : " Workflow is not included unless --workflow-postgres is selected."} This does not enumerate Auth sessions or fence in-flight work/object writes; local or managed Workflow, providers, logs, derived copies and backups are outside this report` };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:inspect:closure -- --metadata sqlite|postgres|convex [--workflow-postgres] --read-only (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, AUTH_PROVIDER, UPLOAD_STORAGE_PROVIDER and selected backend settings; Supabase Auth inspection also needs SUPABASE_AUTH_URL and SUPABASE_AUTH_ADMIN_KEY; Workflow inspection needs WORKFLOW_POSTGRES_URL)";
  const metadata = args[0] === "--metadata" ? args[1] : undefined,objects = env.UPLOAD_STORAGE_PROVIDER;
  const workflowPostgres = args.length === 4 && args[2] === "--workflow-postgres";
  if ((!workflowPostgres && args.length !== 3) || args.at(-1) !== "--read-only" || !["sqlite","postgres","convex"].includes(metadata ?? "") ||
      !["local","supabase","aws-s3"].includes(objects ?? "") || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    const report = await inspectAccountClosure(metadata as MetadataProvider,objects as ObjectProvider,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },env,fetch,{ workflowPostgres });
    console.log(JSON.stringify(report,null,2));
  } catch {
    // Neither an identity nor a backend URL/path/key may enter diagnostics.
    console.error("Account closure inspection failed. Check metadata and object backend access and configuration.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
