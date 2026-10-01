import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { accountDataInventory,readAccountSchemaSources,verifyAccountDataInventory } from "./account-data-inventory.mjs";

const page = z.object({ owned: z.number().int().nonnegative(),orphans: z.number().int().nonnegative(),
  scanned: z.number().int().min(0).max(100),done: z.boolean(),cursor: z.string().nullable() }).strict();
const MAX_PAGES = 100_000;

/** Backend-only, paged Convex inspection. Each page is a separate read snapshot. */
export async function inspectConvexAccountData(siteUrl: string,secret: string,tenant: string,subject: string,request: typeof fetch = fetch) {
  verifyAccountDataInventory(readAccountSchemaSources());
  const url = new URL(siteUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)) ||
      secret.length < 32 || secret.length > 512 || !tenant || !subject || tenant.length > 200 || subject.length > 200)
    throw new Error("Invalid Convex account inspection configuration.");
  const endpoint = new URL("/app/audit",url),ownerRows: Record<string,number> = {},orphanRows: Record<string,number> = {};
  let pages = 0;
  for (const entry of accountDataInventory.filter(item => item.convex && item.owner !== "global-expiring" && item.owner !== "closure-control")) {
    let cursor: string | null = null;
    ownerRows[entry.entity] = 0;
    if (entry.owner !== "direct") orphanRows[entry.entity] = 0;
    do {
      if (++pages > MAX_PAGES) throw new Error("Convex account inspection exceeded the page limit.");
      const response = await request(endpoint,{ method: "POST",redirect: "error",signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json","x-jumpstart-audit-key": secret },
        body: JSON.stringify({ operation: "accountPage",entity: entry.convex,tenant,subject,cursor }) });
      if (!response.ok) throw new Error("Convex account inspection request failed.");
      const result = page.parse(await response.json());
      if (result.done !== (result.cursor === null) || !result.done && (!result.scanned || result.cursor === cursor) ||
          result.owned + result.orphans > result.scanned || entry.owner === "direct" && result.orphans !== 0)
        throw new Error("Convex account inspection returned an invalid page.");
      ownerRows[entry.entity] += result.owned;
      if (entry.owner !== "direct") orphanRows[entry.entity] += result.orphans;
      if (!Number.isSafeInteger(ownerRows[entry.entity]) ||
          entry.owner !== "direct" && !Number.isSafeInteger(orphanRows[entry.entity]))
        throw new Error("Convex account inspection count exceeded the supported range.");
      cursor = result.cursor;
    } while (cursor !== null);
  }
  const fenceResponse = await request(endpoint,{ method: "POST",redirect: "error",signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json","x-jumpstart-audit-key": secret },
    body: JSON.stringify({ operation: "accountFenceStatus",tenant,subject }) });
  if (!fenceResponse.ok) throw new Error("Convex account fence inspection request failed.");
  const applicationWriteFenced = z.object({ fenced: z.boolean() }).strict().parse(await fenceResponse.json()).fenced;
  const ownerRowTotal = Object.values(ownerRows).reduce((sum,value) => sum+value,0);
  const orphanRowTotal = Object.values(orphanRows).reduce((sum,value) => sum+value,0);
  if (!Number.isSafeInteger(ownerRowTotal) || !Number.isSafeInteger(orphanRowTotal)) throw new Error("Convex account inspection total exceeded the supported range.");
  return { format: "ai-app-jumpstart-account-data-inspection-v1",provider: "convex",ownerRows,orphanRows,applicationWriteFenced,
    ownerRowTotal,orphanRowTotal,
    scope: "multiple bounded application read snapshots plus a separate permanent-fence query; this report does not inspect private object bytes, Auth, Eve, providers, logs or backups" };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:inspect:convex -- --read-only (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, CONVEX_SITE_URL and CONVEX_AUDIT_SECRET in the environment)";
  if (args.length !== 1 || args[0] !== "--read-only" || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT ||
      !env.CONVEX_SITE_URL || !env.CONVEX_AUDIT_SECRET) { console.error(usage);process.exitCode = 2;return; }
  try { console.log(JSON.stringify(await inspectConvexAccountData(env.CONVEX_SITE_URL,env.CONVEX_AUDIT_SECRET,
    env.ACCOUNT_AUDIT_TENANT,env.ACCOUNT_AUDIT_SUBJECT),null,2)); }
  catch { console.error("Convex account inspection failed. Check deployment, audit secret, permissions and schema.");process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
