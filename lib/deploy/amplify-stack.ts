import { AmplifyHostingConstruct, type DeployManifest } from "@aws-amplify/hosting";
import { CfnOutput, Duration, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { CfnRestApi } from "aws-cdk-lib/aws-apigateway";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { AllowedMethods, CachePolicy, CfnDistribution, OriginProtocolPolicy, OriginRequestPolicy,
  HeadersFrameOption, HeadersReferrerPolicy, ResponseHeadersPolicy, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { ApiDestination, Authorization, Connection, HttpMethod, Rule, RuleTargetInput, Schedule } from "aws-cdk-lib/aws-events";
import { ApiDestination as ApiDestinationTarget } from "aws-cdk-lib/aws-events-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { amplifyEnvironment, type AmplifyConfig } from "./amplify-config";

export class JumpstartAmplifyStack extends Stack {
  constructor(scope: Construct, config: AmplifyConfig, source: DeployManifest, props: StackProps = {}) {
    super(scope, config.stackName, { ...props, env: { account: config.account, region: config.region } });
    if (source.compute.default?.runtime !== "nodejs24.x" || source.compute.default?.streaming !== true ||
      source.compute.default?.handler !== "index.handler" || source.compute.default?.placement !== "regional")
      throw new Error("Use the generated Node 24 streaming Amplify web artifact.");
    // Edge header rules must not overwrite the request-specific CSP returned by
    // Proxy. The Next handler already owns these headers for dynamic responses.
    const manifest = { ...source, headers: source.headers?.map(row => ({ ...row,
      headers: Object.fromEntries(Object.entries(row.headers).filter(([name]) => name.toLowerCase() !== "content-security-policy")),
    })) };
    const headers = new ResponseHeadersPolicy(this, "Headers", { securityHeadersBehavior: {
      contentTypeOptions: { override: false }, frameOptions: { frameOption: HeadersFrameOption.DENY, override: false },
      referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.NO_REFERRER, override: false },
      strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: false },
    } });
    const hosting = new AmplifyHostingConstruct(this, "Hosting", {
      manifest, domain: { domainName: new URL(config.appOrigin).hostname,
        certificate: Certificate.fromCertificateArn(this, "Certificate", config.certificateArn) },
      cdn: { responseHeadersPolicy: headers, ssrDefaultTtl: Duration.seconds(0) },
    });
    const web = hosting.computeFunctions.get("default");
    if (!(web instanceof LambdaFunction)) throw new Error("Amplify did not create its regional default web function.");
    for (const [name, value] of Object.entries(amplifyEnvironment(config))) web.addEnvironment(name, value);
    for (const [name, arn] of Object.entries(config.secrets)) {
      // Resolve only at CloudFormation deployment into this server-side Lambda
      // environment. Native secret() markers require getSecret(), which this
      // application's process.env consumers do not call.
      web.addEnvironment(name, Secret.fromSecretCompleteArn(this, `Secret-${name}`, arn!).secretValue.unsafeUnwrap());
    }
    const guard = Secret.fromSecretCompleteArn(this, "OriginGuard", config.originGuardSecretArn).secretValue.unsafeUnwrap();
    const worker = new HttpOrigin(new URL(config.eveOrigin).hostname, { protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: Duration.seconds(60), customHeaders: { "X-Jumpstart-Origin": guard,
        "X-Forwarded-Host": new URL(config.appOrigin).hostname, "X-Forwarded-Proto": "https" } });
    for (const prefix of ["/eve/*", "/.well-known/workflow/*"]) hosting.distribution.addBehavior(prefix, worker, {
      allowedMethods: AllowedMethods.ALLOW_ALL, viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      cachePolicy: CachePolicy.CACHING_DISABLED, originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: headers,
    });
    const distribution = hosting.distribution.node.defaultChild as CfnDistribution;
    // The upstream KVS router shares this behavior across assets and SSR. This
    // account app always opts out of CDN caching, including cookie/token pages.
    distribution.addPropertyOverride("DistributionConfig.DefaultCacheBehavior.CachePolicyId", CachePolicy.CACHING_DISABLED.cachePolicyId);
    // Replace the upstream deterministic Referer guard with an actual managed
    // secret on BOTH ends. Fail on an unexpected native resource graph.
    const origins = this.resolve(distribution.distributionConfig).origins as { originCustomHeaders?: { headerName: string; headerValue: string }[] }[];
    let guards = 0;
    origins.forEach((origin, i) => origin.originCustomHeaders?.forEach((header, j) => {
      if (header.headerName.toLowerCase() !== "referer") return;
      distribution.addPropertyOverride(`DistributionConfig.Origins.${i}.OriginCustomHeaders.${j}.HeaderValue`, guard); guards++;
    }));
    const apis = hosting.node.findAll().filter((node): node is CfnRestApi => node instanceof CfnRestApi);
    if (guards !== 1 || apis.length !== 1) throw new Error("Unexpected Amplify origin graph; review upstream routing before deploying.");
    apis[0].addPropertyOverride("Policy", { Version: "2012-10-17", Statement: [
      { Effect: "Allow", Principal: "*", Action: "execute-api:Invoke", Resource: "execute-api:/*" },
      { Effect: "Deny", Principal: "*", Action: "execute-api:Invoke", Resource: "execute-api:/*",
        Condition: { StringNotEquals: { "aws:Referer": guard } } },
    ] });
    // vercel.json is ignored on this host. Native EventBridge calls the existing
    // protected GET route; its event/target never contains the credential.
    const cron = Secret.fromSecretCompleteArn(this, "CleanupSecret", config.secrets.CRON_SECRET!).secretValue.unsafeUnwrap();
    const connection = new Connection(this, "CleanupConnection", {
      authorization: Authorization.apiKey("Authorization", SecretValue.unsafePlainText(`Bearer ${cron}`)),
    });
    const destination = new ApiDestination(this, "CleanupDestination", { connection,
      endpoint: `${config.appOrigin}/api/internal/uploads/cleanup`, httpMethod: HttpMethod.GET, rateLimitPerSecond: 1 });
    const failures = new Queue(this, "CleanupFailures", { encryption: QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14) });
    new Rule(this, "CleanupDaily", { schedule: Schedule.cron({ minute: "0", hour: "2" }), targets: [
      new ApiDestinationTarget(destination, { event: RuleTargetInput.fromObject({}), deadLetterQueue: failures,
        retryAttempts: 2, maxEventAge: Duration.hours(1) }),
    ] });
    new CfnOutput(this, "CleanupFailuresQueue", { value: failures.queueName });
    new CfnOutput(this, "ApplicationOrigin", { value: config.appOrigin });
    new CfnOutput(this, "EveOrigin", { value: config.eveOrigin });
  }
}
