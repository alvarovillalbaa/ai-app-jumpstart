import { z } from "zod";
import { authSettings } from "../auth/settings";

const httpsOrigin = z.string().max(180).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.port && !url.username && !url.password &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
});
const secretNames = ["SUPABASE_SECRET_KEY", "DATABASE_URL", "CONVEX_BACKEND_SECRET", "APP_API_KEYS",
  "AI_CREATION_SIGNING_JSON", "AI_BUDGET_POLICY_JSON", "CRON_SECRET"] as const;
const schema = z.object({
  stackName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,99}$/),
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^(af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d$/),
  appOrigin: httpsOrigin,
  eveOrigin: httpsOrigin,
  certificateArn: z.string(),
  originGuardSecretArn: z.string(),
  dataProvider: z.enum(["postgres", "supabase", "convex"]),
  supabaseAuthUrl: httpsOrigin,
  supabasePublishableKey: z.string().min(32).max(2048).refine(value => !value.startsWith("sb_secret_")),
  supabaseUrl: httpsOrigin.optional(),
  convexSiteUrl: httpsOrigin.optional(),
  chatEnabled: z.boolean(),
  secrets: z.partialRecord(z.enum(secretNames), z.string()),
}).strict();
export type AmplifyConfig = z.infer<typeof schema>;

/** Offline configuration: only managed locators, never a server credential value. */
export function amplifyConfig(input: unknown): AmplifyConfig {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error("Invalid Amplify configuration. Check the example field names and types; private values are never printed.");
  const config = result.data;
  try { authSettings({ NODE_ENV: "production", AUTH_PROVIDER: "supabase", SUPABASE_AUTH_URL: config.supabaseAuthUrl, SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey }); }
  catch { throw new Error("Amplify needs a public Supabase publishable or legacy anon key, never a service-role credential."); }
  if (/REPLACE|example\.(com|org|test)|\.invalid/.test(JSON.stringify(config))) throw new Error("Replace the Amplify example placeholders before synthesis.");
  if (config.appOrigin === config.eveOrigin) throw new Error("Amplify needs a separate Eve worker origin.");
  const arn = new RegExp(`^arn:aws:secretsmanager:${config.region}:${config.account}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`);
  if (!arn.test(config.originGuardSecretArn) || Object.values(config.secrets).some(value => !arn.test(value)))
    throw new Error("Amplify secrets must be complete Secrets Manager ARNs in the stack account and region.");
  if (!new RegExp(`^arn:aws:acm:us-east-1:${config.account}:certificate/[a-f0-9-]{36}$`).test(config.certificateArn))
    throw new Error("Amplify needs a CloudFront certificate ARN in us-east-1 in the stack account.");
  const backendSecret = { postgres: "DATABASE_URL", supabase: "SUPABASE_SECRET_KEY", convex: "CONVEX_BACKEND_SECRET" } as const;
  const required: (typeof secretNames)[number][] = [backendSecret[config.dataProvider], "CRON_SECRET"];
  if (config.chatEnabled) required.push("AI_CREATION_SIGNING_JSON", "AI_BUDGET_POLICY_JSON");
  if (required.some(name => !config.secrets[name])) throw new Error("Amplify is missing required backend, cleanup or enabled-chat secret references.");
  if ((config.dataProvider === "supabase") !== !!config.supabaseUrl || (config.dataProvider === "convex") !== !!config.convexSiteUrl)
    throw new Error("Set only the URL matching the selected data provider.");
  for (const name of Object.values(backendSecret)) if (name !== backendSecret[config.dataProvider] && config.secrets[name])
    throw new Error("Amplify must not inject credentials for unselected data providers.");
  if (!config.chatEnabled && (config.secrets.AI_CREATION_SIGNING_JSON || config.secrets.AI_BUDGET_POLICY_JSON))
    throw new Error("Disabled chat must not receive execution credentials.");
  return config;
}

export function amplifyEnvironment(config: AmplifyConfig): Record<string, string> {
  return {
    APP_ORIGIN: config.appOrigin, AUTH_PROVIDER: "supabase", DATA_PROVIDER: config.dataProvider,
    SUPABASE_AUTH_URL: config.supabaseAuthUrl, SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey,
    AI_CHAT_ENABLED: String(config.chatEnabled),
    // Server-to-server SDK calls use the same CloudFront routes as the browser;
    // the distribution supplies the private worker-origin guard on their behalf.
    ...(config.chatEnabled ? { AI_RUNTIME_ORIGIN: config.appOrigin } : {}),
    ...(config.supabaseUrl ? { SUPABASE_URL: config.supabaseUrl } : {}),
    ...(config.convexSiteUrl ? { CONVEX_SITE_URL: config.convexSiteUrl } : {}),
  };
}
