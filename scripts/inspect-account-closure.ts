import { isAbsolute,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccountSchemaSources,verifyAccountDataInventory } from "./account-data-inventory.mjs";
import { inspectPostgresAccountData,inspectSqliteAccountData } from "./inspect-account-data.mjs";
import { inspectConvexAccountData } from "./inspect-convex-account-data";
import { inspectAccountObjects } from "./inspect-account-objects";
import { inspectAccountAuth } from "./inspect-account-auth";
import { inspectSupabaseAuthSessionRows } from "./inspect-account-auth-sessions";
import { inspectAccountWorkflow } from "./inspect-account-workflow.mjs";

type MetadataProvider = "sqlite" | "postgres" | "convex";
type ObjectProvider = "local" | "supabase" | "aws-s3";
type Owner = { tenant: string;subject: string };

/** One fail-closed operator report spanning application rows, their write fence, configured Auth identity and private objects. */
export async function inspectAccountClosure(metadataProvider: MetadataProvider,objectProvider: ObjectProvider,
  owner: Owner,env: Record<string,string | undefined>,request: typeof fetch = fetch,
  options: { authSessionsPostgres?: boolean;workflowPostgres?: boolean } = {}) {
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
  let authSessionRows: number | null = null;
  if (options.authSessionsPostgres) {
    if (auth.authProvider !== "supabase") throw new Error("Auth session inspection requires AUTH_PROVIDER=supabase.");
    if (!env.SUPABASE_AUTH_DATABASE_URL) throw new Error("A Supabase Auth database URL is required for session inspection.");
    authSessionRows = await inspectSupabaseAuthSessionRows(env.SUPABASE_AUTH_DATABASE_URL,owner.subject,auth.authIdentityPresent);
  }
  const objects = await inspectAccountObjects(objectProvider,owner,env);
  const workflow = options.workflowPostgres ? await inspectAccountWorkflow(metadataProvider,owner,env,request) : null;
  const workflowRowsRemain = workflow ? Object.values(workflow.linkedRuns).some(count => count > 0) : null;
  const workflowUnattributedRoots = workflow?.otherSessionRoots ?? null;
  const remaining = { applicationRows: rows.ownerRowTotal > 0,privateObjects: objects.objectCount > 0,
    globalUnattributableRows: rows.orphanRowTotal > 0,applicationWritesPossible: !rows.applicationWriteFenced,
    authIdentity: auth.authIdentityPresent,authSessionRows,workflowRows: workflowRowsRemain,
    workflowUnattributedRoots };
  const observedDataRemains = remaining.applicationRows || remaining.privateObjects || remaining.globalUnattributableRows ||
    remaining.authIdentity || (remaining.authSessionRows ?? 0) > 0 || remaining.workflowRows === true ||
    (remaining.workflowUnattributedRoots ?? 0) > 0;
  return { format: "ai-app-jumpstart-account-closure-observation-v3",
    status: observedDataRemains ? "retained_or_unattributable"
      : rows.applicationWriteFenced ? "application_fenced_zero" : "unfenced_zero",
    metadataProvider,objectProvider,authProvider: auth.authProvider,
    authIdentityApplicable: auth.authIdentityApplicable,authIdentityPresent: auth.authIdentityPresent,remaining,
    authSessionRows,
    applicationWriteFenced: rows.applicationWriteFenced,
    ownerRows: rows.ownerRows,orphanRows: rows.orphanRows,ownerRowTotal: rows.ownerRowTotal,
    orphanRowTotal: rows.orphanRowTotal,objectCount: objects.objectCount,
    workflow: workflow ? { provider: "postgres",boundSessionCount: workflow.boundSessionCount,
      linkedRuns: workflow.linkedRuns,otherSessionRoots: workflow.otherSessionRoots } : null,
    inspectedEntities: Object.keys(rows.ownerRows).length,
    scope: `SQLite/PostgreSQL row counts and permanent row-fence status share one read snapshot; Convex bounded counts and its fence query are separate snapshots. When Supabase Auth is configured, an operator lookup checks the exact registered user without returning identity fields; api-key mode has no Auth identity.${options.authSessionsPostgres ? " The --auth-sessions-postgres option counts rows in auth.sessions through the separately configured SUPABASE_AUTH_DATABASE_URL and compares user presence with the Auth admin lookup; this is a separate snapshot, returns no session identifiers, and counts table rows rather than active sessions. Pairing that URL with the selected Auth project remains an operator responsibility." : " Auth session rows are unknown unless --auth-sessions-postgres is selected."} Private objects are a separate observation.${workflow ? " Linked PostgreSQL Workflow runs and child-row counts use separate application-binding and Workflow read snapshots. The global count of session roots not linked to the selected owner is reported as workflowUnattributedRoots; any nonzero count prevents a zero status and may include other accounts. Auxiliary or unlinked runs are not attributed or erased." : " Workflow is not included unless --workflow-postgres is selected."} This does not fence in-flight work/object writes; local or managed Workflow, providers, logs, derived copies and backups are outside this report` };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:inspect:closure -- --metadata sqlite|postgres|convex [--auth-sessions-postgres] [--workflow-postgres] --read-only (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, AUTH_PROVIDER, UPLOAD_STORAGE_PROVIDER and selected backend settings; Supabase Auth inspection needs SUPABASE_AUTH_URL and SUPABASE_AUTH_ADMIN_KEY; session-row inspection also needs SUPABASE_AUTH_DATABASE_URL for the same Auth project; Workflow inspection needs WORKFLOW_POSTGRES_URL)";
  const metadata = args[0] === "--metadata" ? args[1] : undefined,objects = env.UPLOAD_STORAGE_PROVIDER;
  const optionalArgs = args.slice(2,-1),optionalFlags = new Set(optionalArgs);
  const allowedFlags = new Set(["--auth-sessions-postgres","--workflow-postgres"]);
  const validOptions = optionalArgs.length <= allowedFlags.size && optionalArgs.every(flag => allowedFlags.has(flag)) && optionalFlags.size === optionalArgs.length;
  const authSessionsPostgres = optionalFlags.has("--auth-sessions-postgres"),workflowPostgres = optionalFlags.has("--workflow-postgres");
  if (!validOptions || args.length < 3 || args.length > 5 || args.at(-1) !== "--read-only" || !["sqlite","postgres","convex"].includes(metadata ?? "") ||
      !["local","supabase","aws-s3"].includes(objects ?? "") || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    const report = await inspectAccountClosure(metadata as MetadataProvider,objects as ObjectProvider,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },env,fetch,{ authSessionsPostgres,workflowPostgres });
    console.log(JSON.stringify(report,null,2));
  } catch {
    // Neither an identity nor a backend URL/path/key may enter diagnostics.
    console.error("Account closure inspection failed. Check metadata and object backend access and configuration.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
