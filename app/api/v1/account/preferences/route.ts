import { preferenceHandlers } from "@/lib/http/account-preferences";
export const runtime = "nodejs";
export function GET(request: Request) { return preferenceHandlers().get(request); }
export function PATCH(request: Request) { return preferenceHandlers().update(request); }
