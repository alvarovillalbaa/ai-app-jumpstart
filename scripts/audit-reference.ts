import { runtimeReference } from "../lib/observability/runtime";

const values = process.argv.slice(2);
if (values.length !== 1 || !values[0] || values[0].length>4096) {
  console.error("Usage: npm run audit:reference -- RUNTIME_ID_OR_CONFIGURED_NAME");process.exitCode = 1;
} else console.log(runtimeReference(values[0]));
