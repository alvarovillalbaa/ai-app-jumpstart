import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { postgresWorkflowSettings } from "@jumpstart/workflow-postgres/config";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
postgresWorkflowSettings();
// Invoke the pinned upstream migration owner, not a floating npx install. Its
// diagnostics can contain URL parameters; never forward them to application logs.
const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("@workflow/world-postgres/cli"))], {
  env: process.env, stdio: ["ignore", "ignore", "ignore"],
});
const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
try {
  const [code, signal] = await once(child, "exit");
  if (code !== 0 || signal) throw new Error("Workflow migration failed. Verify database connectivity, privileges, and the pinned workflow package compatibility.");
  console.log("PostgreSQL workflow schema is ready.");
} finally { clearTimeout(timer); }
