import { uploadHandlers } from "@/lib/http/uploads";
export const runtime = "nodejs";
export const GET = uploadHandlers().list;
export const POST = uploadHandlers().create;
