import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { nextjsAdapter } from "@aws-amplify/hosting/adapters";

for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(name)) throw new Error("Use a build checkout without private environment files.");
}
if (process.env.HOSTING_LENIENT_PATCHES) throw new Error("Amplify adapter patches must fail closed; unset HOSTING_LENIENT_PATCHES.");
const privateNames = ["DATABASE_URL", "SUPABASE_SECRET_KEY", "CONVEX_BACKEND_SECRET", "APP_API_KEYS", "AI_CREATION_SIGNING_JSON",
  "AI_BUDGET_POLICY_JSON", "CRON_SECRET", "AI_GATEWAY_API_KEY", "WORKFLOW_POSTGRES_URL", "UPLOAD_SCANNER_TOKEN", "UPLOAD_DOWNLOAD_SIGNING_JSON"];
if (privateNames.some(name => process.env[name])) throw new Error("Build the Amplify artifact without private application credentials; inject them only at runtime.");
let origin;
try { origin = new URL(process.env.EVE_NEXT_PRODUCTION_ORIGIN); }
catch { throw new Error("Set the separate HTTPS EVE_NEXT_PRODUCTION_ORIGIN before building the Amplify web artifact."); }
if (origin.protocol !== "https:" || origin.origin !== process.env.EVE_NEXT_PRODUCTION_ORIGIN || origin.username || origin.password) {
  throw new Error("EVE_NEXT_PRODUCTION_ORIGIN must be an HTTPS origin without a path or credentials.");
}
if (process.env.VERCEL || process.env.EVE_WORKFLOW_PROVIDER === "postgres") throw new Error("Build the Amplify web artifact separately from Vercel and the PostgreSQL Eve worker.");
const manifest = nextjsAdapter({ projectDir: resolve("."), configPath: "open-next.config.ts" });
mkdirSync(".amplify-build", { recursive: true });
writeFileSync(".amplify-build/manifest.json", JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
writeFileSync(".amplify-build/build.json", JSON.stringify({ eveOrigin: origin.origin }) + "\n", { mode: 0o600 });
console.log("Amplify self-managed web artifact built. The separate Eve worker and cloud acceptance are still required.");
