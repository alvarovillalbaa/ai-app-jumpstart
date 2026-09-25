import { createUploadCatalog } from "../lib/uploads/catalog-store";
import { cleanupUploads } from "../lib/uploads/cleanup";
import { createUploadObjects } from "../lib/uploads/objects-store";

let catalog;
try {
  catalog = await createUploadCatalog();
  const result = await cleanupUploads(catalog,await createUploadObjects());
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} catch {
  console.error("Upload cleanup failed. Check the data and private object providers.");
  process.exitCode = 1;
} finally { await catalog?.close(); }
