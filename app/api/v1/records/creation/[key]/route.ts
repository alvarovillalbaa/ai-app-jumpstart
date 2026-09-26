import { recordHandlers } from "@/lib/http/records";
export const runtime = "nodejs";
const handlers = recordHandlers();
type Context = { params: Promise<{ key: string }> };
export async function GET(request: Request,ctx: Context) { return handlers.creation(request,(await ctx.params).key); }
