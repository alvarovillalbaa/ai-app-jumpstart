# Cloud container recipes

The same Node/Docker application can run on AWS ECS/Fargate, Azure Container Apps or Google Cloud Run. The example definitions under `deploy/` use a PostgreSQL workflow build, Supabase application data and Auth, one continuously running instance, and provider-managed secret references. They contain no live account identifiers or credentials. JSON syntax and repository-owned deployment invariants pass an offline preflight; none has been submitted to a cloud control plane. Infrastructure provisioning, IAM, networking, domains and provider acceptance remain required.

For separate Next and Eve services, use the [streaming ingress recipe](hosting.md#split-next-and-eve-behind-one-streaming-ingress). Route the two Eve prefixes directly at ingress; the Next rewrite buffered a delayed SSE fixture locally. A [Compose overlay](../compose.streaming.yaml) proves this path with co-located app and Eve processes on a private network. AWS uses ALB path routing to send Eve and Workflow paths directly to the app task's Eve port; Azure and GCP retain a Caddy ingress sidecar on port 8080. Local streaming checks pass, but owned turns through provider load balancers remain unverified.

## Shared release preparation

Use the [migration job generator](cloud-migrations.md) to produce separate application preview/apply and Workflow apply jobs from the reviewed runtime manifest. It reuses the pinned image and managed references while removing web/agent startup and ingress; observe successful terminal job executions before runtime rollout.

Build the app image for the destination architecture and pin its registry digest. Azure and GCP also use the Caddy ingress image; AWS routes through ALB directly to the app task. The AWS example selects x86-64; build Linux amd64 for that definition and for the documented Cloud Run path:

```sh
docker buildx build --platform linux/amd64 \
  --build-arg EVE_WORKFLOW_PROVIDER=postgres \
  -t YOUR_REGISTRY/jumpstart:YOUR_RELEASE --push .
# Azure and GCP sidecar ingress only; AWS uses its ALB listener rules.
docker buildx build --platform linux/amd64 \
  -f deploy/ingress.Dockerfile \
  -t YOUR_REGISTRY/jumpstart-ingress:YOUR_RELEASE --push .
```

These commands publish images when you run them. Use your organization's approved registry and credentials. The app image copies pruned runtime dependencies and excludes the build-only Turbopack cache. A PostgreSQL Workflow image built before the later structured-result recovery UI edit was loaded locally for `linux/amd64` and passed the ten-migration two-database Compose contract under emulation, including the artifact retention schema. An earlier ARM64 Workflow image also passed that contract; a fresh current-source default-world ARM64 image passed the runtime and nine-chat-browser contracts, including result recovery. Reproduce the amd64 architecture and Compose checks against the latest source without publishing:

```sh
docker buildx build --platform linux/amd64 \
  --build-arg EVE_WORKFLOW_PROVIDER=postgres \
  --load -t ai-app-jumpstart:workflow-postgres-amd64-test .
docker image inspect ai-app-jumpstart:workflow-postgres-amd64-test \
  --format '{{.Os}}/{{.Architecture}}'
TEST_WORKFLOW_IMAGE=ai-app-jumpstart:workflow-postgres-amd64-test \
  npm run test:workflow-compose -- --skip-build
```

The inspected architecture should be `linux/amd64`. On an ARM host, Docker needs amd64 emulation and enough VM memory for the build; the local proof used a 6 GiB Colima VM after a 3 GiB build exhausted memory. Emulated local success does not establish registry delivery, cloud networking or provider control-plane acceptance.
If your Docker CLI does not discover the Buildx plugin, the standalone `docker-buildx build` binary accepts the same arguments; select the intended Docker context with `DOCKER_CONTEXT` for the build and test commands.

Prepare a private workflow PostgreSQL database and run `npm run workflow:migrate` with its explicit URL/prefix. Prepare application migrations independently. Store the references needed by the example in the selected cloud's secret manager: workflow connection, application URL/key, Supabase Auth URL/public key, signing keyring, reviewed budget policy with a cost basis, and model credential. Run `npm run check:budget-policy` against that private policy before release. Grant only the workload identities that need the secrets access. For PostgreSQL application data replace `DATA_PROVIDER=supabase` and its two data references with `DATA_PROVIDER=postgres` and `DATABASE_URL`; for Convex use `DATA_PROVIDER=convex`, `CONVEX_SITE_URL` and `CONVEX_BACKEND_SECRET`. Supabase Auth remains independent of that choice. With PostgreSQL or Convex metadata, private objects can use `UPLOAD_STORAGE_PROVIDER=supabase` with separate server-only managed `SUPABASE_URL` and `SUPABASE_SECRET_KEY` references. The disposable Convex plus real Storage browser contract passed locally; repeat object and account acceptance against the chosen hosted services before release.

Copy the appropriate example to an environment-owned file, replace every `REPLACE_…` marker, set a unique workflow job prefix, and review it. Pin secret versions where the provider supports them. Keep the image/world, application database and workflow database selection together. All three manifests set `WORKFLOW_EXPECTED_PROVIDER=postgres`; the supervisor checks the build marker before starting and refuses a default-world image or missing PostgreSQL workflow URL. The examples enable account chat and therefore require all [account-chat settings](account-chat.md) before startup. The broker reaches the co-located Eve process at `127.0.0.1:4274`; Azure/GCP Caddy sidecars also reach Eve at that address and Next at `127.0.0.1:3000`. AWS binds Eve to the task network interface for ALB routing, while `AI_RUNTIME_ORIGIN` remains on loopback. Clients use the public HTTPS app origin. `APP_AGENT_READINESS=local` makes the app readiness check include Eve. Preserve the `/eve/` and `/.well-known/workflow/` route prefixes and streaming responses. Keep app ports private: AWS allows only the ALB security group to reach 3000/4274, while Azure/GCP expose only the Caddy target port 8080.

Before submitting a filled definition, run `npm run check:cloud-config -- --provider aws --file YOUR_TASK_DEFINITION.json`, changing `aws` to `azure` or `gcp` for the other examples. The offline preflight requires a digest-pinned app image (and an ingress image for Azure/GCP), no unresolved `REPLACE_` markers, provider-managed references for workflow, data/Auth and model secrets, a public HTTPS app origin, an explicit literal `APP_REQUESTS_PER_MINUTE` (`0` or `1`–`10000`), private app/Eve ports, one always-on replica where the manifest controls it, and the shared readiness/ingress contract. If uploads are enabled, it rejects `local` storage on these ephemeral cloud instances and requires a managed `CRON_SECRET` reference on the application container; Supabase Storage needs managed `SUPABASE_URL` and `SUPABASE_SECRET_KEY` references even when application data uses PostgreSQL or Convex, while S3 needs literal valid region/bucket settings. Supplied AWS credential environment variables must be managed secret references; prefer a workload role where available. The preflight does not check bucket privacy, IAM, credential validity, scanner behavior or object durability, so run the selected storage adapter's live acceptance before serving uploads. `npm run check:cloud-templates` checks the three committed examples in placeholder-permitting mode; `--template` is available for an individual example but is not a release check. The preflight prints provider, data provider, secret-reference count and the selected request limit. It does not contact cloud APIs, verify secret contents, IAM, registry digest availability, database access, Workflow image contents, load balancer behavior, deployed streaming or an installed cleanup schedule.

If you add optional `APP_API_KEYS`, provide its digest configuration through a managed secret reference. Cloud scan-on-read downloads need private object storage, a literal HTTPS `UPLOAD_SCANNER_URL`, `UPLOAD_SCANNER_PROVIDER=remote` and a managed `UPLOAD_SCANNER_TOKEN`; the same scanner shape is required whenever its settings are supplied. `UPLOAD_AGENT_POLICY=reviewed-text` additionally requires scan-on-read. Optional download-link signing material and supplied cleanup credentials also stay in managed references. The preflight validates configuration shape only; run the remote scanner's live clean/EICAR acceptance before exposing downloads or reviewed-file reading.

When uploads are enabled, use the [cloud cleanup job generator and acceptance recipe](cloud-cleanup.md) to derive a separate scheduled job from the reviewed runtime manifest. It pins the same production app image, selects only the deployed HTTPS origin and managed `CRON_SECRET` reference, and runs the bounded protected-route caller. The runtime preflight checks the application secret reference; each scheduler job, its identity and its actual execution need separate review and live acceptance.

## AWS ECS/Fargate

Private uploads can use the [AWS S3 adapter](uploads.md#aws-s3-private-object-storage) instead of a host volume or Supabase Storage. Grant its bucket/object actions to the **task role**, separate from the execution role that pulls images and reads selected runtime secrets. [The example task policy](../deploy/aws/upload-task-policy.example.json) scopes object actions to `uploads/v1/*`; replace its bucket placeholder, review it with your security team and attach it to the task role. Set `UPLOAD_STORAGE_PROVIDER=aws-s3`, `UPLOAD_S3_REGION` and `UPLOAD_S3_BUCKET` on the application container, then run the read-only `check:upload-s3` preflight. The repository does not provision the bucket or IAM policy; review these resources and test them in a disposable AWS account before enabling uploads.

Start from `deploy/aws/task-definition.example.json`. It has one app container, so an optional S3 task role is not shared with a public Caddy sidecar. AWS makes the task role available to containers in the task ([task IAM role behavior](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html)). Provision the cluster, VPC/subnets, egress to the databases/providers, security groups and log group. The example [ALB CloudFormation template](../deploy/aws/alb-routing.example.json) creates IP target groups on ports 3000 and 4274, a TLS listener whose default route goes to Next, and a higher-priority rule sending `/eve/*` and `/.well-known/workflow/*` to Eve. It checks `/api/health/ready` and `/eve/v1/health`, respectively. Its default listener security policy is AWS's current post-quantum-capable TLS recommendation; choose an organization-approved policy from the [ALB security policy list](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/describe-ssl-policies.html) if needed. Deploy it against a public ALB with an unused HTTPS port 443 and an ACM certificate:

```sh
aws cloudformation deploy --template-file deploy/aws/alb-routing.example.json \
  --stack-name jumpstart-staging-alb-routing \
  --region YOUR_REGION \
  --parameter-overrides VpcId=vpc-YOUR_VPC LoadBalancerArn=YOUR_ALB_ARN \
  CertificateArn=YOUR_CERTIFICATE_ARN EveRulePriority=20
```

Create/update the ECS service with both output target groups, mapping `app` port 3000 to the Next target group and port 4274 to the Eve target group. Give the service at least 120 seconds of health-check grace while the combined app and Eve readiness starts. Set the task security group to accept those ports only from the ALB security group and assign no public IP to tasks. The task definition sets `EVE_LISTEN_HOST=0.0.0.0` for ALB reachability; keep task ports private with the security group. The execution role needs image-pull, log-write and selected secret-read permissions. Grant only required app permissions to the task role. The app's `/api/health/ready` check includes application data and the co-located Eve process. Configure the ALB idle timeout for SSE and allow connection draining during replacement. The example template creates the listener and target groups; the cluster, ALB, VPC, security groups, ECS service and DNS remain operator-managed.

```sh
aws ecs register-task-definition --cli-input-json file://YOUR_TASK_DEFINITION.json
```

Create/update an ECS service with the returned task-definition revision, Fargate launch type, your reviewed network configuration and both ALB target groups. Keep desired count at least one. Run release migrations as a separate one-off task with the same image and selected secret references before updating the service. Do not run migrations concurrently in every app container. Follow [AWS task-definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html), [multiple target groups for an ECS service](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/register-multiple-targetgroups.html) and [ALB path conditions](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html#path-conditions).

For uploads, generate the [one-container cleanup task definition](cloud-cleanup.md) and schedule its reviewed revision with EventBridge Scheduler.

## Azure Container Apps

Start from `deploy/azure/container-app.example.json`. Provision a Container Apps environment with a dedicated workload profile that keeps at least one profile instance running, an application replica minimum of one, and an identity with the required Key Vault access. Each Key Vault secret reference must use `system` only when the system identity is enabled, or an attached user-assigned identity resource ID; this supports separate identities for different secrets. `npm run check:cloud-templates` verifies that every referenced identity is enabled on the app. For Azure Container Registry image pulls, use `system` or an attached user-assigned identity with the `AcrPull` role and omit username/password fields. Other registries can use a username and `passwordSecretRef` pointing to a Key Vault-backed app secret. The preflight validates these auth shapes but cannot verify Azure role assignments or a live image pull. See Microsoft's [Container Apps registry authentication guide](https://learn.microsoft.com/en-us/azure/container-apps/containers#managed-identity-with-azure-container-registry). The example uses versioned Key Vault references and HTTPS ingress to the Caddy container on port 8080. Size the dedicated workload profile for both containers (the example requests 2.25 CPU and 4.5 GiB per replica). Bind the chosen custom domain/certificate and configure matching Supabase redirects.

```sh
az containerapp create --name YOUR_APP --resource-group YOUR_RESOURCE_GROUP \
  --yaml YOUR_CONTAINER_APP.json
```

JSON is valid YAML input. For an existing application, use the reviewed `az containerapp update --yaml` path. Run migrations as a separately controlled job/process with the same database identity. Review the [Container Apps template specification](https://learn.microsoft.com/en-us/azure/container-apps/azure-resource-manager-api-spec) and [workload profiles](https://learn.microsoft.com/en-us/azure/container-apps/workload-profiles-overview).

For uploads, generate the [scheduled Container Apps cleanup job](cloud-cleanup.md) with its selected Key Vault-backed `CRON_SECRET` reference.

## Google Cloud Run

Start from `deploy/gcp/service.example.json`. Set `serviceAccountName` to a dedicated user-managed service-account email and grant only the runtime permissions it needs. The offline preflight checks that email shape and rejects the default Compute Engine service-account form; it cannot verify the account exists or inspect IAM grants. Google [recommends user-managed service identities](https://docs.cloud.google.com/run/docs/securing/service-identity) for least privilege. Also provision restricted Secret Manager access, registry access, database connectivity and the public domain. Set each environment `secretKeyRef.key` to a positive numeric version or `latest`; the preflight rejects placeholders and other values in filled definitions. Google recommends pinning environment-variable secrets to a version because they are resolved at instance startup ([Cloud Run secrets guide](https://docs.cloud.google.com/run/docs/configuring/services/secrets)). The definition disables CPU throttling, keeps one minimum instance, sends public traffic to the Caddy container on port 8080 and allows up to a one-hour request. It starts the app before the proxy and allocates CPU and memory to both containers. The app and proxy startup/readiness probes check application data and the co-located Eve process; liveness checks the web process. Cloud Run can send traffic immediately after startup succeeds, before its first readiness probe, so startup must use the combined check. PostgreSQL workers need CPU when no HTTP request is active; minimum instances alone do not establish that. See [Cloud Run health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks), [billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings) and the [YAML reference](https://docs.cloud.google.com/run/docs/reference/yaml/v1).

```sh
gcloud run services replace YOUR_SERVICE.json --region YOUR_REGION --project YOUR_PROJECT
```

Configure the service invoker policy deliberately. A public browser application needs public HTTP ingress for sign-in, while the application still verifies every protected API/session operation. Adding `allUsers` as a service invoker is a separate reviewed IAM action; the manifest does not perform it. Run migrations in a separate controlled Cloud Run job or database release process. Cloud Run can replace instances even with a minimum configured, so persistence/reconnect checks are mandatory.

For uploads, generate the [Cloud Run cleanup job](cloud-cleanup.md) and schedule it with Cloud Scheduler after reviewing its Secret Manager reference and identity.

## Acceptance for every provider

Record both deployed image digests, region, application revision, workflow package versions and migration results. Verify liveness, combined readiness and `/eve/v1/health` through the public origin, then use two real test users to exercise sign-in, create, stream with distinct chunks before completion, follow up, reload, cross-user denial, cancellation and quota exhaustion. If uploads are enabled, run the scheduled cleanup job once and confirm a successful bounded result, then confirm its normal schedule and failure alert are active. Replace the running instance and verify history and a new owned turn. Exercise network loss/reconnect through the real load balancer, test graceful shutdown and backup restore, and review logs for secrets or prompt content. A green deployment or health response is not proof of these behaviors. Keep paid model smoke tests explicitly budgeted.

For a deployment with separate self-hosted PostgreSQL application and Workflow databases, the [stopped two-database set](postgres-recovery.md) provides a local archive/restore rehearsal and one hash manifest. Provider-managed database snapshots and external object storage still need their own recovery checks; the repository test does not prove a cloud control-plane restore.

## Amplify

Amplify's newer [self-managed hosting](https://docs.amplify.aws/nextjs/deploy-and-host/self-hosting/frameworks/) is a separate path from the managed SSR service described below. The [self-managed recipe](amplify-self-managed.md) now builds its native OpenNext adapter for the pinned Next 16 / Node 24 app, synthesizes CloudFormation offline and passes actual local Lambda/browser/PostgreSQL contracts. It uses a separately hosted PostgreSQL Eve worker, guarded direct streaming origins and authenticated daily cleanup. AWS control-plane and deployed acceptance remain pending; the adapter's upstream patch-range warning is documented in that recipe.

The pinned app is Next.js 16.3.8 on Node 24 and uses streaming. AWS's [Amplify SSR support page](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html), checked 2026-09-25, documents support through Next.js 15 and lists Next.js streaming as unsupported. AWS now [supports Node 24](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-supported-features.html), so Node itself is not the gate. A custom adapter is possible under the [deployment specification](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-deployment-specification.html), but its compute bundle must be self-contained and at most 220 MB uncompressed; it does not establish Next 16 or streaming support for this app. The current app cannot be presented as an accepted Amplify SSR deployment. A split service alone does not remove the web-side version/streaming mismatch. Keep Amplify as a compatibility gate; do not silently downgrade Next or disable required chat behavior to claim support. Vercel remains the managed serverless path; the long-running container recipes above cover the three clouds pending actual provider acceptance.
