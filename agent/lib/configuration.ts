import { workflowConfiguration } from "./workflow";

/** Compose experimental options without replacing the selected durable world. */
export function agentConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const workflow = workflowConfiguration(env);
  return { ...workflow,experimental: { ...workflow.experimental,instrumentationProviders: true } };
}
