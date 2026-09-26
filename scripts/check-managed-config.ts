import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { config } from "../lib/config";
import { authSettings } from "../lib/auth/settings";
import { chatSettings } from "../lib/agent-access/settings";
import { trustedHttpOrigin } from "../lib/security/origin";
import { remoteScannerSettings } from "../lib/uploads/scanner";
import { uploadLinkSettings } from "../lib/uploads/download-links";

function httpsOrigin(value: string | undefined, name: string) {
  const origin = trustedHttpOrigin(value);
  if (!origin || !origin.startsWith("https://")) throw new Error(`Set ${name} to a public HTTPS origin.`);
  return origin;
}

/** Offline shape check for the managed Vercel + Supabase runtime configuration. */
export function checkManagedConfig(env: NodeJS.ProcessEnv, requireChat = false) {
  const required = ["APP_ORIGIN", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY"];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Set ${missing.join(", ")} before a managed deployment.`);
  if (env.DATA_PROVIDER !== "supabase") throw new Error("Set DATA_PROVIDER=supabase for the managed Vercel + Supabase path.");
  if (env.AUTH_PROVIDER !== "supabase") throw new Error("Set AUTH_PROVIDER=supabase for managed account sign-in.");
  if (env.AI_CHAT_ENABLED !== "true" && env.AI_CHAT_ENABLED !== "false") {
    throw new Error("Set AI_CHAT_ENABLED explicitly to true or false.");
  }
  if (requireChat && env.AI_CHAT_ENABLED !== "true") throw new Error("Enable and configure AI_CHAT_ENABLED=true before requiring an agent turn.");
  if ((env.EVE_WORKFLOW_PROVIDER && env.EVE_WORKFLOW_PROVIDER !== "default") ||
      (env.WORKFLOW_EXPECTED_PROVIDER && env.WORKFLOW_EXPECTED_PROVIDER !== "default")) {
    throw new Error("The managed Vercel build must select the default Workflow world.");
  }
  if (env.APP_AGENT_READINESS === "local") throw new Error("APP_AGENT_READINESS=local requires a co-located Eve process; remove it on Vercel.");
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 32 || /\s/.test(env.CRON_SECRET)) {
    throw new Error("Set CRON_SECRET to at least 32 non-whitespace characters for the scheduled upload cleanup route.");
  }
  if (env.UPLOAD_STORAGE_PROVIDER && env.UPLOAD_STORAGE_PROVIDER !== "supabase") {
    throw new Error("Set UPLOAD_STORAGE_PROVIDER=supabase or leave uploads disabled on Vercel.");
  }
  const scannerConfigured = Boolean(env.UPLOAD_SCANNER_PROVIDER || env.UPLOAD_CLAMD_SOCKET || env.UPLOAD_SCANNER_URL || env.UPLOAD_SCANNER_TOKEN);
  if (scannerConfigured) {
    try { remoteScannerSettings(env); }
    catch { throw new Error("Vercel upload scanning requires UPLOAD_SCANNER_PROVIDER=remote, a valid HTTPS UPLOAD_SCANNER_URL and a server-only UPLOAD_SCANNER_TOKEN."); }
    if (env.UPLOAD_STORAGE_PROVIDER !== "supabase") throw new Error("Configure Supabase upload storage before enabling remote scanning.");
  }
  if (env.UPLOAD_DOWNLOAD_POLICY && (env.UPLOAD_DOWNLOAD_POLICY !== "scan-on-read" || !scannerConfigured)) {
    throw new Error("Vercel upload downloads require scan-on-read and an authenticated remote scanner.");
  }
  if (env.UPLOAD_DOWNLOAD_SIGNING_JSON) {
    uploadLinkSettings(env);
    if (env.UPLOAD_DOWNLOAD_POLICY !== "scan-on-read") throw new Error("Upload download links require scan-on-read and its configured scanner.");
  }
  if (env.SUPABASE_SECRET_KEY === env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY?.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_SECRET_KEY must be a backend credential distinct from SUPABASE_PUBLISHABLE_KEY.");
  }
  if (env.SUPABASE_SECRET_KEY?.includes("...") || env.SUPABASE_PUBLISHABLE_KEY?.includes("...")) {
    throw new Error("Replace the placeholder Supabase keys before deployment.");
  }

  // Reuse the same parsers that production requests use. Convert their errors
  // to names-only diagnostics so a malformed secret never appears in output.
  try { config({ ...env, NODE_ENV: "production", VERCEL: "1" }); }
  catch { throw new Error("Application configuration is invalid; check APP_ORIGIN and Supabase data settings."); }
  const origin = httpsOrigin(env.APP_ORIGIN, "APP_ORIGIN");
  httpsOrigin(env.SUPABASE_URL, "SUPABASE_URL");
  if (env.SUPABASE_AUTH_URL) httpsOrigin(env.SUPABASE_AUTH_URL, "SUPABASE_AUTH_URL");
  try { if (!authSettings(env)) throw new Error("missing"); }
  catch { throw new Error("Supabase Auth settings are invalid; check SUPABASE_AUTH_URL and SUPABASE_PUBLISHABLE_KEY."); }
  if (env.EVE_NEXT_PRODUCTION_ORIGIN) httpsOrigin(env.EVE_NEXT_PRODUCTION_ORIGIN, "EVE_NEXT_PRODUCTION_ORIGIN");

  if (env.AI_CHAT_ENABLED === "true") {
    const chatRequired = ["AI_RUNTIME_ORIGIN", "AI_CREATION_SIGNING_JSON", "AI_BUDGET_POLICY_JSON"];
    const chatMissing = chatRequired.filter(name => !env[name]?.trim());
    if (chatMissing.length) throw new Error(`Set ${chatMissing.join(", ")} before enabling account chat.`);
    httpsOrigin(env.AI_RUNTIME_ORIGIN, "AI_RUNTIME_ORIGIN");
    try { if (!chatSettings(env)) throw new Error("missing"); }
    catch { throw new Error("Account chat settings are invalid; check Auth, signing keyring and reviewed budget policy."); }
  }
  return { target: "vercel-supabase" as const, origin, accountChat: env.AI_CHAT_ENABLED === "true" ? "enabled" as const : "disabled" as const };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== "--require-chat")) {
    console.error("Supported option: --require-chat.");
    process.exitCode = 2;
  } else {
    try {
      const result = checkManagedConfig(process.env, args[0] === "--require-chat");
      console.log(`Managed Vercel + Supabase configuration shape passed; account chat ${result.accountChat}.`);
      console.log("Still required: migration dry run/review, Vercel project setup, deployment, hosted data and owned-turn smoke.");
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Managed configuration is invalid.");
      process.exitCode = 1;
    }
  }
}
