import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CachePolicy } from "aws-cdk-lib/aws-cloudfront";
import type { DeployManifest } from "@aws-amplify/hosting";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amplifyConfig } from "../../lib/deploy/amplify-config";
import { JumpstartAmplifyStack } from "../../lib/deploy/amplify-stack";
import { filledAmplifyConfig } from "../../tests/helpers/amplify-config";

const directory = await mkdtemp(join(tmpdir(), "jumpstart-amplify-synth-"));
try {
  const config = amplifyConfig(filledAmplifyConfig());
  const manifest = JSON.parse(await readFile(".amplify-build/manifest.json", "utf8")) as DeployManifest;
  // An upstream adapter adding baseline edge headers must still preserve the
  // per-request origin nonce. Inspect the real native router's KVS data too.
  manifest.headers = [{ source: "/:path*", headers: { "Content-Security-Policy": "baseline-would-overwrite-nonce" } }];
  const app = new App({ outdir: directory, context: { "@aws-cdk/core:checkSecretUsage": true } });
  const stack = new JumpstartAmplifyStack(app, config, manifest);
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
  const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0].Properties.DistributionConfig;
  assert.equal(distribution.DefaultCacheBehavior.CachePolicyId, CachePolicy.CACHING_DISABLED.cachePolicyId);
  for (const path of ["/eve/*", "/.well-known/workflow/*"]) {
    const behavior = distribution.CacheBehaviors.find((row: { PathPattern: string }) => row.PathPattern === path);
    assert.ok(behavior, "Direct Eve prefix must have a native behavior");
    assert.equal(behavior.CachePolicyId, CachePolicy.CACHING_DISABLED.cachePolicyId);
    assert.equal(behavior.AllowedMethods.length, 7);
    const origin = distribution.Origins.find((row: { Id: string }) => row.Id === behavior.TargetOriginId);
    assert.equal(origin.DomainName, new URL(config.eveOrigin).hostname);
    assert.ok(JSON.stringify(origin.OriginCustomHeaders).includes(config.originGuardSecretArn));
    assert.ok(origin.OriginCustomHeaders.some((row: { HeaderName: string; HeaderValue: string }) =>
      row.HeaderName.toLowerCase() === "x-forwarded-host" && row.HeaderValue === new URL(config.appOrigin).hostname));
    assert.equal(origin.CustomOriginConfig.OriginProtocolPolicy, "https-only");
  }
  const api = Object.values(template.findResources("AWS::ApiGateway::RestApi"))[0].Properties;
  const guard = api.Policy.Statement.find((row: { Effect: string }) => row.Effect === "Deny").Condition.StringNotEquals["aws:Referer"];
  assert.ok(guard.includes(config.originGuardSecretArn));
  const guardedOrigin = distribution.Origins.find((row: { OriginCustomHeaders?: { HeaderName: string; HeaderValue: string }[] }) =>
    row.OriginCustomHeaders?.some(header => header.HeaderName.toLowerCase() === "referer"));
  assert.equal(guardedOrigin.OriginCustomHeaders.find((row: { HeaderName: string }) => row.HeaderName.toLowerCase() === "referer").HeaderValue, guard);
  const methods = Object.values(template.findResources("AWS::ApiGateway::Method"));
  assert.ok(methods.length >= 2);
  for (const method of methods) assert.equal(method.Properties.Integration.ResponseTransferMode, "STREAM");
  const functions = Object.values(template.findResources("AWS::Lambda::Function"));
  const web = functions.filter(row => row.Properties.Environment?.Variables?.APP_ORIGIN);
  assert.equal(web.length, 1, "Application credentials belong only to the web Lambda");
  assert.equal(web[0].Properties.Runtime, "nodejs24.x");
  const env = web[0].Properties.Environment.Variables;
  assert.ok(env.SUPABASE_SECRET_KEY.includes("{{resolve:secretsmanager:"));
  assert.ok(env.CRON_SECRET.includes("{{resolve:secretsmanager:"));
  assert.equal(env.AUTH_PROVIDER, "supabase");
  assert.equal(env.AI_CHAT_ENABLED, "false");
  for (const fn of functions) assert.equal(fn.Properties.Environment?.Variables?.AI_GATEWAY_API_KEY, undefined);
  const policy = Object.values(template.findResources("AWS::CloudFront::ResponseHeadersPolicy"))[0].Properties.ResponseHeadersPolicyConfig;
  assert.equal(policy.SecurityHeadersConfig.ContentSecurityPolicy, undefined);
  assert.equal(policy.SecurityHeadersConfig.FrameOptions.Override, false);
  const connection = Object.values(template.findResources("AWS::Events::Connection"))[0].Properties;
  assert.equal(connection.AuthParameters.ApiKeyAuthParameters.ApiKeyName, "Authorization");
  assert.ok(connection.AuthParameters.ApiKeyAuthParameters.ApiKeyValue.includes(`Bearer {{resolve:secretsmanager:${config.secrets.CRON_SECRET}`));
  const destination = Object.values(template.findResources("AWS::Events::ApiDestination"))[0].Properties;
  assert.equal(destination.HttpMethod, "GET");
  assert.equal(destination.InvocationEndpoint, `${config.appOrigin}/api/internal/uploads/cleanup`);
  const daily = Object.values(template.findResources("AWS::Events::Rule")).find(row => row.Properties.ScheduleExpression === "cron(0 2 * * ? *)");
  assert.ok(daily, "Non-Vercel cleanup needs a real daily schedule");
  assert.deepEqual(daily.Properties.Targets[0].RetryPolicy, { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 });
  assert.equal(daily.Properties.Targets[0].Input, "{}");
  assert.ok(daily.Properties.Targets[0].DeadLetterConfig.Arn);
  const assembly = app.synth();
  assert.ok(assembly.stacks[0].template);
  // Baseline CSP must not appear in inline edge configuration either.
  const text = JSON.stringify(template.toJSON());
  assert.ok(!text.includes("baseline-would-overwrite-nonce"));
  console.log("Native Amplify CloudFormation: streaming integration, uncached auth routes, private runtime references, guarded direct Eve origins, preserved CSP and authenticated daily cleanup with a failure queue passed offline.");
} finally { await rm(directory, { recursive: true, force: true }); }
