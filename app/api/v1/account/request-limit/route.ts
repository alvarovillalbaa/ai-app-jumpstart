import { accountRequestLimitHandler } from "@/lib/http/account-request-limit";
export const runtime = "nodejs";
export function GET(request: Request) { return accountRequestLimitHandler()(request); }
