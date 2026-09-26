import { Pool } from "pg";
import { postgresWorkflowSettings } from "../packages/workflow-postgres/config.mjs";

const usage = "Usage: npm run workflow:recover -- list | unlock --worker-id WORKER_ID --confirm-dead";
const [action, ...args] = process.argv.slice(2);
if (action !== "list" && action !== "unlock") {
  console.error(usage);
  process.exit(2);
}
if (action === "list" && args.length !== 0) {
  console.error(usage);
  process.exit(2);
}
let workerId;
if (action === "unlock") {
  if (args.length !== 3 || args[0] !== "--worker-id" || args[2] !== "--confirm-dead" || !/^[^\s\x00-\x1f]{10,200}$/.test(args[1] ?? "")) {
    console.error(usage);
    process.exit(2);
  }
  workerId = args[1];
}

let pool;
try {
  const settings = postgresWorkflowSettings();
  const task = `${settings.jobPrefix}flows`;
  pool = new Pool({ connectionString: settings.connectionString, max: 1, connectionTimeoutMillis: 5000 });
  if (action === "list") {
    const result = await pool.query(`SELECT id, task_identifier, queue_name, locked_by, locked_at, attempts, max_attempts
      FROM graphile_worker.jobs WHERE task_identifier = $1 AND locked_by IS NOT NULL
      ORDER BY locked_at, id LIMIT 101`, [task]);
    console.log(JSON.stringify({ jobPrefix: settings.jobPrefix, lockedJobs: result.rows.slice(0,100), more: result.rows.length > 100 }, null, 2));
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const result = await client.query(`SELECT task_identifier, count(*)::integer AS jobs
        FROM graphile_worker.jobs WHERE locked_by = $1 GROUP BY task_identifier`, [workerId]);
      if (!result.rows.length) throw new Error("No jobs are locked by that worker ID.");
      if (result.rows.some(row => row.task_identifier !== task)) throw new Error("Worker ID also owns jobs outside this application prefix.");
      await client.query("SELECT graphile_worker.force_unlock_workers(ARRAY[$1]::text[])", [workerId]);
      await client.query("COMMIT");
      console.log(JSON.stringify({ jobPrefix: settings.jobPrefix, workerId, unlockedJobs: result.rows[0].jobs }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
} catch (error) {
  // Database drivers can include connection parameters in errors. Keep those out of logs.
  console.error(error instanceof Error && ["No jobs are locked by that worker ID.", "Worker ID also owns jobs outside this application prefix."].includes(error.message)
    ? error.message : "Workflow recovery failed. Check database connectivity, schema and permissions.");
  process.exitCode = 1;
} finally { await pool?.end(); }
