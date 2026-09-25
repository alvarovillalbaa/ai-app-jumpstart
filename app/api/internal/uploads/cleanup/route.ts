import { uploadCleanupHandler } from "@/lib/http/upload-cleanup";

export const runtime = "nodejs";
export const GET = uploadCleanupHandler();
