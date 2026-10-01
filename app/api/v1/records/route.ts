import { recordHandlers } from "@/lib/http/records";
export const runtime = "nodejs";
const handlers = recordHandlers();
export const GET = handlers.list;
export const POST = handlers.create;
