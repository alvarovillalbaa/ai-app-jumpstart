import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { amplifyConfig, amplifyEnvironment } from "../../lib/deploy/amplify-config";
import { filledAmplifyConfig } from "../helpers/amplify-config";

it("requires filled configuration and separates the web environment from Eve worker secrets", () => {
  expect(() => amplifyConfig(JSON.parse(readFileSync("deploy/aws/amplify.example.json", "utf8")))).toThrow("Invalid Amplify");
  const fixture = filledAmplifyConfig();
  const config = amplifyConfig(fixture);
  expect(amplifyEnvironment(config)).toMatchObject({ AUTH_PROVIDER: "supabase", DATA_PROVIDER: "supabase", AI_CHAT_ENABLED: "false" });
  expect(JSON.stringify(amplifyEnvironment(config))).not.toMatch(/secret:|AI_GATEWAY|WORKFLOW_|AI_RUNTIME_ORIGIN/);
  expect(config).toEqual(fixture);
});

it("accepts each remote data adapter with only its matching backend locator", () => {
  for (const provider of ["postgres", "supabase", "convex"] as const) {
    const config = filledAmplifyConfig(); config.dataProvider = provider;
    if (provider !== "supabase") {
      delete config.supabaseUrl; delete config.secrets.SUPABASE_SECRET_KEY;
      config.secrets[provider === "postgres" ? "DATABASE_URL" : "CONVEX_BACKEND_SECRET"] = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:data-fixture-Abcdef";
    }
    if (provider === "convex") config.convexSiteUrl = "https://fixture.convex.site";
    expect(amplifyConfig(config).dataProvider).toBe(provider);
  }
});

it("rejects plaintext credentials and unknown environment keys without echoing their values", () => {
  for (const secrets of [{ SUPABASE_SECRET_KEY: "private-credential-value" }, { AI_GATEWAY_API_KEY: "private-credential-value" }]) {
    try { amplifyConfig({ ...filledAmplifyConfig(), secrets }); throw new Error("Expected rejection"); }
    catch (error) { expect(String(error)).not.toContain("private-credential-value"); expect(String(error)).toContain("Amplify"); }
  }
  expect(() => amplifyConfig({ ...filledAmplifyConfig(), dataProvider: "sqlite" })).toThrow("Invalid Amplify");
});

it("rejects service-role credentials in the public auth setting", () => {
  for (const key of ["sb_secret_" + "a".repeat(40), `e30.${Buffer.from('{"role":"service_role"}').toString("base64url")}.signature`])
    expect(() => amplifyConfig({ ...filledAmplifyConfig(), supabasePublishableKey: key })).toThrow("Amplify");
});

it("requires enabled chat credentials and refuses unused backend or disabled-chat secrets", () => {
  const config = filledAmplifyConfig(); config.chatEnabled = true;
  expect(() => amplifyConfig(config)).toThrow("missing required");
  config.secrets.AI_CREATION_SIGNING_JSON = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:signing-fixture-Abcdef";
  config.secrets.AI_BUDGET_POLICY_JSON = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:budget-fixture-Abcdef";
  expect(amplifyEnvironment(amplifyConfig(config)).AI_RUNTIME_ORIGIN).toBe(config.appOrigin);
  config.chatEnabled = false; expect(() => amplifyConfig(config)).toThrow("Disabled chat");
  config.secrets.DATABASE_URL = config.secrets.CRON_SECRET;
  expect(() => amplifyConfig(config)).toThrow("unselected data");
});

it("refuses malformed origins, certificate region and secret account/region locators", () => {
  for (const eveOrigin of ["https://user:password@host.dev", "https://eve.host.dev/path", "https://eve.host.dev:8443", "http://eve.host.dev", filledAmplifyConfig().appOrigin])
    expect(() => amplifyConfig({ ...filledAmplifyConfig(), eveOrigin })).toThrow("Amplify");
  const config = filledAmplifyConfig(); config.certificateArn = config.certificateArn.replace("us-east-1", "eu-west-1");
  expect(() => amplifyConfig(config)).toThrow("certificate");
  config.certificateArn = filledAmplifyConfig().certificateArn;
  config.secrets.CRON_SECRET = config.secrets.CRON_SECRET!.replace("eu-west-1", "us-west-2");
  expect(() => amplifyConfig(config)).toThrow("stack account and region");
});
