import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = "/api/internal/uploads/cleanup";

/** Run bounded, authenticated cleanup passes against a deployed application. */
export async function runUploadCleanup({ origin, secret, request = fetch, maxBatches = 20 }) {
  let url;
  try {
    url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error();
  } catch { throw new Error("APP_ORIGIN must be a public HTTPS origin."); }
  if (typeof secret !== "string" || secret.length < 32 || /\s/.test(secret)) {
    throw new Error("CRON_SECRET must contain at least 32 non-whitespace characters.");
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 20) {
    throw new Error("maxBatches must be an integer from 1 to 20.");
  }
  const totals = { batches: 0, scanned: 0, deleted: 0, skipped: 0, failed: 0 };
  for (let batch = 0; batch < maxBatches; batch++) {
    const response = await request(`${url.origin}${endpoint}`, {
      headers: { authorization: `Bearer ${secret}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cleanup endpoint returned HTTP ${response.status}.`);
    const result = await response.json();
    if (!result || typeof result !== "object" || typeof result.more !== "boolean" ||
        !["scanned","deleted","skipped","failed"].every(name =>
          Number.isSafeInteger(result[name]) && result[name] >= 0)) {
      throw new Error("Cleanup endpoint returned an invalid result.");
    }
    totals.batches++;
    for (const name of ["scanned","deleted","skipped","failed"]) totals[name] += result[name];
    if (result.failed) throw new Error("Cleanup endpoint reported failed deletions.");
    if (!result.more) return totals;
  }
  throw new Error(`Cleanup backlog remains after ${maxBatches} bounded passes.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runUploadCleanup({ origin: process.env.APP_ORIGIN, secret: process.env.CRON_SECRET });
    console.log(JSON.stringify(result));
  } catch {
    console.error("Upload cleanup runner failed; check the endpoint, scheduler secret, storage provider and backlog.");
    process.exitCode = 1;
  }
}
