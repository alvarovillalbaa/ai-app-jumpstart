# AWS Amplify self-managed web hosting

The native `@aws-amplify/hosting` adapter builds the pinned Next.js 16.3.5 app into a Node 24 streaming Lambda artifact. A separate long-running Eve worker handles agent execution and PostgreSQL Workflow storage. `npm run synth:amplify` creates a reviewable CDK/CloudFormation assembly without contacting AWS. This is a locally tested deployment recipe; AWS deployment, DNS, managed secrets, registered-user chat and a credentialed production-model turn still need hosted acceptance.

This uses Amplify's newer [self-managed hosting](https://docs.amplify.aws/nextjs/deploy-and-host/self-hosting/frameworks/), rather than the older managed SSR service with its Next.js version/streaming gate. Dependencies are pinned to hosting 1.0.1, OpenNext 4.1.5 and CDK library 2.271.0. The hosting adapter warns that OpenNext 4.1.5 is outside its explicitly validated patch range; all required patches apply and this app's local runtime contracts pass. Do not enable `HOSTING_LENIENT_PATCHES`, silently downgrade Next, or treat these app tests as the complete upstream adapter certification suite.

## Prepare the separate worker

Follow the [AWS container recipe](cloud-containers.md#aws-ecsfargate) for a single long-running task with a PostgreSQL Workflow build, separate application/Workflow databases, verified TLS, migration jobs, IAM and combined readiness. The application image includes the private Next readiness process as well as Eve. For this topology, replace the ingress image with one built from `deploy/amplify-eve.Dockerfile` and pinned by digest. Its target port remains 8080; Next 3000 and Eve 4274 must remain private.

```sh
docker build --file deploy/amplify-eve.Dockerfile --tag your-registry/jumpstart-amplify-eve:review .
```

Terminate TLS at the worker's load balancer under a separate HTTPS hostname. Inject `ORIGIN_GUARD` into the ingress from Secrets Manager: a dedicated, random 32-byte value encoded as 64 lowercase hex characters. Missing or malformed values refuse startup. Set `EVE_UPSTREAM=127.0.0.1:4274` and `NEXT_UPSTREAM=127.0.0.1:3000`. Only `/eve/*` and `/.well-known/workflow/*` are forwarded after the guard check. Readiness endpoints are available to the load balancer without that header; all other guarded paths return 404. This preserves streaming and does not expose the worker's web/API routes.

Use the browser-facing application origin as `APP_ORIGIN` on both services. The worker retains the existing `AI_RUNTIME_ORIGIN=http://127.0.0.1:4274`, PostgreSQL Workflow settings, backend, Supabase Auth, signing and budget policy configuration. Only the worker receives `AI_GATEWAY_API_KEY`. Keep its production model unchanged. The native web Lambda never runs the PostgreSQL Workflow worker.

## Build without private application credentials

Use a checkout without `.env`, `.env.local`, `.env.production` or `.env.production.local`, and unset private application credentials in its shell. AWS build credentials, if present, are separate from application runtime credentials. This command builds the actual native adapter and applies its streaming/image patches:

```sh
npm ci
EVE_NEXT_PRODUCTION_ORIGIN=https://eve.your-domain.tld npm run build:amplify
```

Generated `.open-next/` and `.amplify-build/` output stays ignored. Keep build artifacts private and rebuild for the configured worker origin. `.amplify-build/build.json` records that origin; synthesis refuses a mismatch. `middlewareHeadersOverrideNextConfigHeaders` in `open-next.config.ts` preserves Proxy's nonce CSP instead of replacing it with the baseline Next header.

## Synthesize and review

Copy `deploy/aws/amplify.example.json` outside the source tree and replace every placeholder. The config requires:

- The target commercial AWS account/region, exact application and separate worker HTTPS origins, and an existing CloudFront-compatible certificate in `us-east-1`. Both origins use the standard HTTPS port. Configure DNS externally; synthesis performs no DNS lookup or AWS call.
- Supabase Auth's URL and **public** publishable/legacy anon key, independently of the data adapter. Service-role keys are refused in this public field.
- `supabase`, `postgres` or `convex` application data, with only its matching URL/complete backend secret ARN. Apply that provider's migrations or Convex deployment first. SQLite cannot be used in the web Lambda. Backend connectivity/TLS and any required VPC wiring need operator review; this stack does not provision a database or VPC.
- `requestsPerMinute` sets the [authenticated owner quota](request-limits.md), defaulting to 120; use 0 to disable it. Apply the limiter migration/functions before serving requests. The quota lives in the selected database and is shared across Lambda invocations.
- Complete same-account/region Secrets Manager ARNs for `CRON_SECRET` and `originGuardSecretArn`. Use the same origin guard value on the worker ingress. Secret strings contain the exact raw runtime value, not a wrapper object. Cleanup requires at least 32 random characters. Signing/budget configuration strings are their existing JSON contracts.
- Explicit `chatEnabled`. When true, also supply `AI_CREATION_SIGNING_JSON` and `AI_BUDGET_POLICY_JSON` references matching the worker. The web broker uses the public application origin, so CloudFront supplies the origin guard for its signed session and SDK calls too. A records-only staging config starts with chat disabled.

```sh
npm run synth:amplify -- --config /private/path/amplify-staging.json
```

The command refuses to overwrite an existing `cdk.out`. Move the previous assembly aside before another synthesis. Review the assembly with your organization's approved CDK release tooling. Deployment is a separate operator action; no build/test/synthesis command deploys resources.

Application credentials are resolved through [CloudFormation Secrets Manager dynamic references](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html) into **only the server-side web Lambda environment**. Templates contain locators rather than credential values; do not grant untrusted identities permission to read Lambda environment configuration. Native Amplify `secret()` markers would require `getSecret()` calls and are intentionally not substituted for this app's `process.env` consumers. AWS's Lambda environment size limit applies to the resolved values, including signing/budget JSON and the adapter's own variables. Check the resulting size before deployment. Secrets are resolved at deployment, not fetched on each request; rotation must update/redeploy affected resources. Rotate the origin guard by changing its secret ARN and update both worker and distribution together, allowing CloudFront propagation.

The stack uses native S3 assets, cache/revalidation resources, streaming API Gateway integration, Lambda and CloudFront. Dynamic/default CDN caching is disabled for this account app, which also reduces CDN caching of assets reached through the shared native router. It preserves the origin's CSP and blocks an upstream static CSP override. The upstream deterministic Referer guard is replaced with the dedicated managed secret on both CloudFront and API Gateway. Eve/Workflow have separate non-cached CloudFront behaviors forwarding cookies, authorization, methods and query parameters directly to the guarded worker.

## Daily cleanup and operational checks

`vercel.json` crons do not execute on this host. This stack creates a daily 02:00 UTC EventBridge rule and API destination targeting the existing protected `GET /api/internal/uploads/cleanup`. Its connection stores the bearer credential; events/targets do not contain it. Delivery has two retries within one hour and an encrypted failure queue retaining events for 14 days. Inspect that queue and provision your organization's alarms before release. [API destinations have a five-second execution timeout](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-api-destinations.html); verify cleanup duration under the actual deployment workload or use the existing operator CLI/job path for longer work. Upload storage/scanner wiring is not supplied by this initial Amplify config; records-only cleanup acknowledges `storage_disabled`.

After deployment, run `npm run smoke:hosted -- --browser` with two deliberately provisioned owner credentials and the public application URL, then the registered-user and [account-chat acceptance](account-chat.md) checks. Verify CloudFront does not cache owner data or nonce HTML, direct API Gateway calls are denied, the worker rejects missing/wrong guards, cookies/signatures survive both routes, Workflow callbacks reach the PostgreSQL worker, SSE arrives incrementally, cleanup authentication/delivery works, and the failure queue remains empty. Complete the unchanged production-model turn, recovery/backup and hosted scanner checks separately. Local checks do not prove any of these cloud control-plane/runtime conditions.

## Reproducible local verification

```sh
npm run test:amplify-build
npm run test:amplify-ingress
```

The first builds the real adapter and Eve worker, synthesizes native CloudFormation offline, invokes the generated Node 24 handler against a disposable PostgreSQL database, checks cleanup authorization, runs two-owner REST/CLI/MCP parity and seven browser hydration/CSP/accessibility contracts. Its API Gateway transport is a local fixture, not an AWS emulator. The second requires Docker and checks the actual worker ingress image: fail-closed startup, missing/wrong guards, readiness, blocked web routes, authenticated Workflow forwarding and incremental SSE. CI runs the adapter as its own job and the ingress in the existing workflow-container job. These checks use isolated fixtures and make no AWS or paid model calls.
