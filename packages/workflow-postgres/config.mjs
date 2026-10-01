/** No implicit localhost credentials or application DATABASE_URL fallback. */
export function postgresWorkflowSettings(env = process.env) {
  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME) throw new Error("PostgreSQL workflows require a continuously running worker, not a request-scoped function.");
  const connectionString = env.WORKFLOW_POSTGRES_URL;
  let url;
  try { url = new URL(connectionString); } catch { throw new Error("Set WORKFLOW_POSTGRES_URL explicitly for the workflow database."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error("WORKFLOW_POSTGRES_URL must name a PostgreSQL database.");
  const integer = (name, fallback, max) => {
    const raw = env[name] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) throw new Error(`Invalid ${name}.`);
    return Number(raw);
  };
  const queueConcurrency = integer("WORKFLOW_POSTGRES_WORKER_CONCURRENCY", 5, 100);
  const maxPoolSize = integer("WORKFLOW_POSTGRES_MAX_POOL_SIZE", Math.max(10, queueConcurrency + 2), 200);
  if (maxPoolSize < queueConcurrency + 2) throw new Error("Workflow pool size must exceed worker concurrency by at least two connections.");
  const jobPrefix = env.WORKFLOW_POSTGRES_JOB_PREFIX;
  if (!jobPrefix || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(jobPrefix)) throw new Error("Set a stable WORKFLOW_POSTGRES_JOB_PREFIX for this application and environment.");
  return { connectionString, queueConcurrency, maxPoolSize, jobPrefix, applicationManagedShutdown: true };
}
