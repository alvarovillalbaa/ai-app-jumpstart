/** This choice is compiled into the Eve artifact; credentials remain runtime-only. */
export function workflowConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.EVE_WORKFLOW_PROVIDER ?? "default";
  if (provider === "default") return {};
  if (provider !== "postgres") throw new Error("EVE_WORKFLOW_PROVIDER must be default or postgres.");
  if (env.VERCEL) throw new Error("Use the default Vercel Workflow world for Vercel builds.");
  return {
    experimental: { workflow: { world: "@jumpstart/workflow-postgres" } },
    build: { externalDependencies: ["@jumpstart/workflow-postgres", "@workflow/world-postgres"] },
  };
}
