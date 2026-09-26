import { provisionPrivateUploadBucket, SUPABASE_UPLOAD_BUCKET, uploadStorageClient, verifyPrivateUploadBucket } from "../lib/uploads/supabase";
import { verifyUploadStoragePolicy } from "../lib/uploads/storage-policy";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--create")) throw new Error("Usage: npm run check:upload-storage -- [--create]");
await verifyUploadStoragePolicy(process.env.DATABASE_URL ?? "");
const storage = uploadStorageClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SECRET_KEY ?? "").storage;
if (args.includes("--create")) await provisionPrivateUploadBucket(storage);
else await verifyPrivateUploadBucket(storage);
console.log(`${SUPABASE_UPLOAD_BUCKET}: private bucket verified`);
