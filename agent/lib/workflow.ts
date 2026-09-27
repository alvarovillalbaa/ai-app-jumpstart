import { requireReplayRetention } from "../../scripts/workflow-retention.mjs";

/** This choice is compiled into the Eve artifact; credentials remain runtime-only. */
export function workflowConfiguration(env: NodeJS.ProcessEnv = process.env): {
  experimental?: { workflow: { world?: string;retention?: 0 } };
  build?: { externalDependencies: string[] };
} {
  const provider = env.EVE_WORKFLOW_PROVIDER ?? "default";
  const retention = requireReplayRetention(env);
  if (provider === "default") return retention === 0 ? { experimental: { workflow: { retention: 0 } } } : {};
  if (provider !== "postgres") throw new Error("EVE_WORKFLOW_PROVIDER must be default or postgres.");
  if (env.VERCEL) throw new Error("Use the default Vercel Workflow world for Vercel builds.");
  return {
    experimental: { workflow: { world: "@jumpstart/workflow-postgres",...(retention === 0 ? { retention: 0 as const } : {}) } },
    build: { externalDependencies: ["@jumpstart/workflow-postgres", "@workflow/world-postgres"] },
  };
}
